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

// const collectDefaultMetrics = prometheusClient.collectDefaultMetrics;
// collectDefaultMetrics();

const up = new prometheusClient.Gauge({name: 'up', help: 'UP Status'});

const controls = new prometheusClient.Gauge({
  name: 'inspec_checks_total',
  help: 'Number of inspec checks',
  labelNames: ['profile', 'status']
});

const lastModified = new prometheusClient.Gauge({
  name: 'inspec_checks_mtime',
  help: 'Last modified time of inspec checks',
  labelNames: ['profile']
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
      const response = runInSpec();

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
  lastModified.reset();
}

function runInSpec () {
  //inspec supermarket exec dev-sec/cis-docker-benchmark --reporter json | jq

  var dirName = '/usr/local/etc/inspec-results';
  var files = fs.readdirSync(dirName);

  _.each(files, (file) => {
    var fullFilePath = dirName + "/" + file;
    var contents = fs.readFileSync(fullFilePath, 'utf8');
    var mtime = fs.statSync(fullFilePath).mtimeMs;
  
    var currentTime = new Date();
    var age = currentTime - mtime;
  
    var response = JSON.parse(contents);
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
  
      controls.set({
        profile: profileName,
        status: "passed"
      }, numPassed);
  
      controls.set({
        profile: profileName,
        status: "failed"
      }, numFailed);
  
      controls.set({
        profile: profileName,
        status: "skipped"
      }, numSkipped);
  
      lastModified.set({
        profile: profileName
      }, mtime);
    });
  })

}


module.exports = {
  init: init,
  shutdown: shutdown
};
