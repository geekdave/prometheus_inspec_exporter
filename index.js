const _ = require('lodash');
const express = require('express');
const prometheusClient = require('prom-client');
const { spawn } = require('child_process');
var fs = require('fs');
 

var AsyncLock = require('async-lock');
var lock = new AsyncLock();

// const nock = require('nock');
// nock.recorder.rec();

const metricsServer = express();

const DEBUG = process.env['INSPEC_EXPORTER_DEBUG'] || false;

const collectDefaultMetrics = prometheusClient.collectDefaultMetrics;
collectDefaultMetrics();

const up = new prometheusClient.Gauge({name: 'up', help: 'UP Status'});

const controls = new prometheusClient.Gauge({
  name: 'inspec_checks_total',
  help: 'Number of inspec checks',
  labelNames: ['profile', 'status']
});

if (require.main === module) {
  const options = {};

  options.INSPEC_API_TOKEN = process.env.INSPEC_API_TOKEN;
  options.ORG_NAME = process.env.INSPEC_ORG_NAME;
  options.BASE_URL = process.env.INSPEC_API_BASE_URL;

  init(options);
  startServer();
}

function init (options) {

}

function startServer () {
  metricsServer.get('/metrics', async (req, res) => {
    res.contentType(prometheusClient.register.contentType);

    try {
      resetStats();
      var id = Math.random().toString(36).substring(7);
      console.log("starting with id " + id);
      var startTime = new Date();
      const response = await runInSpec();

      var endTime = new Date();
      var timeDiff = endTime - startTime; //in ms
      // strip the ms
      timeDiff /= 1000;
    
      // get seconds 
      var seconds = Math.round(timeDiff);
      console.log("finished with id " + id + " in " + seconds + " seconds");

      res.send(prometheusClient.register.metrics());
    } catch (error) {
      // error connecting
      up.set(0);
      res.header('X-Error', error.message || error);
      res.send(prometheusClient.register.getSingleMetricAsString(up.name));
    }
  });

  console.log('Server listening to 9207, metrics exposed on /metrics endpoint');
  metricsServer.listen(9207);
}

function shutdown () {
  metricsServer.close();
}

function resetStats () {
  up.set(1);
  controls.reset();
}

async function runInSpec () {
  //inspec supermarket exec dev-sec/cis-docker-benchmark --reporter json | jq

  const promise = new Promise((resolve, reject) => {

    const child = spawn('inspec', ['supermarket', 'exec', 'dev-sec/cis-docker-benchmark', '--reporter' , 'json']);

    process.stdin.pipe(child.stdin)

    var jsonString = "";
    child.stdout.on('data', (data) => {
      jsonString += data;
    });

    child.on('exit', function (code, signal) {
      var response = JSON.parse(jsonString);
      // console.log(response);  

      if (!response) {
        throw new Error('error retrieving response from inspec process');
      }

      if (!response.profiles) {
        throw new Error('profiles not found in inspec result');
      }

      _.each(response.profiles, (profile) => {
        const profileName = profile.name;
        
        var numPassed = 0;
        var numFailed = 0;
        var numSkipped = 0;

        _.each(profile.controls, (control) => {
          var controlId = control.id;
          var controlTitle = control.title;
          var controlDesc = control.desc;

          var passed = true;
          var skipped = false;

          if (!control.results || control.results.length === 0) {
            return;
          }

          _.each(control.results, (result) => {
            var status = result.status;
            if (status === "failed") {
              passed = false;
            } else if (status === "skipped") {
              skipped = true;
            }          
          });

          var overallStatus;
          if (!passed) {
            numFailed++;
          } else {
            if (skipped) {
              numSkipped++;
            } else {
              numPassed++;
            }
          }
          // console.log(profileName + " : " + controlId + " : " + overallStatus);
        });
        console.log(profileName + " : passed " + numPassed);
        console.log(profileName + " : failed " + numFailed);
        console.log(profileName + " : skipped " + numSkipped);
      });

      resolve();
    });
  });
  return promise;
}

// limit to 10 results - high churn OK.  after that group into one label

async function processProjects (projectData) {
  let orgId;
  if (projectData.org && projectData.org.id) {
    orgId = projectData.org.id;
  } else {
    throw new Error('Unable to find org id in response data');
  }

  for (let i = 0; i < projectData.projects.length; i++) {
    const project = projectData.projects[i];

    if (DEBUG) {
      console.log(`Project Name: ${project.projectName} Project ID: ${project.projectId}`);
    }

    let issueData = await getIssues(orgId, project);

    if (!issueData.data.issues) {
      throw new Error('Could not find issue object in response data');
    }

    let countsForProject = getVulnerabilityCounts(issueData.data.issues);
    setSeverityGauges(project.name, project.Id, countsForProject.severities);
    setTypeGauges(project.name, project.Id, countsForProject.types);
  }
}

async function getIssues (orgId, project) {
  if (!project) {
    throw new Error('project not provided');
  }

  const issuesQuery = `/org/${orgId}/project/${project.id}/issues`;

  return httpClient.post(
    issuesQuery,
    POST_DATA
  );
}

function getVulnerabilityCounts (issues) {
  const results = {
    severities: {
      high: 0,
      medium: 0,
      low: 0
    },
    types: {}
  };

  // dedupe vulnerabilities - the inSpec API reports vulnerabilities as
  // separate if they are introduced via different top-level packages.
  // we remove duplicate occurrences by comparing the ID.
  const vulnerabilities = _.uniqWith(issues.vulnerabilities, (v1, v2) => {
    return v1.id === v2.id;
  });

  _.each(vulnerabilities, (thisVuln) => {
    const severity = thisVuln.severity;
    if (severity !== 'high' && severity !== 'medium' && severity !== 'low') {
      throw new Error('Invalid severity: ' + severity);
    }

    results.severities[severity]++;

    let thisType = thisVuln.title;
    if (!results.types[thisType]) {
      results.types[thisType] = 1;
    } else {
      results.types[thisType]++;
    }
  });

  return results;
}

function setSeverityGauges (projectName, projectId, severities) {
  _.each(severities, (count, severity) => {
    vulnerabilitiesBySeverity.set({
      project: projectName,
      severity: severity
    }, count);
  });
}

function setTypeGauges (projectName, projectId, types) {
  _.each(types, (count, type) => {
    // console.log(`Type: ${typeName}, Count: ${types[typeName]}`);
    vulnerabilitiesByType.set({
      project: projectName,
      type: type
    }, count);
  });
}

module.exports = {
  init: init,
  shutdown: shutdown
};
