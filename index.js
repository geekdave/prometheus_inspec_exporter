const _ = require('lodash');
const express = require('express');
const prometheusClient = require('prom-client');
const { spawn } = require('child_process');
const fs = require('fs');
const marked = require('marked');

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
  var reportDirName = '/usr/local/etc/inspec-reports';

  var files = fs.readdirSync(dirName);

  _.each(files, (file) => {
    var fullFilePath = dirName + "/" + file;
    var contents = fs.readFileSync(fullFilePath, 'utf8');
    var mtime = fs.statSync(fullFilePath).mtimeMs;
  
    var currentTime = new Date();
    var age = currentTime - mtime;
  
    var response = JSON.parse(contents);

    if (!response) {
      throw new Error('error retrieving response from inspec process');
    }
  
    if (!response.profiles) {
      throw new Error('profiles not found in inspec result');
    }
  
    _.each(response.profiles, (profile) => {

      var rendered = "";

      var tocPassed = "";
      var tocFailed = "";
      var tocSkipped = "";
  
      var summary = "# Summary\n\n";

      var intro = "";

      const profileName = profile.name;

      intro += `# ${profileName}\n\n`;
      
      var numPassed = 0;
      var numFailed = 0;
      var numSkipped = 0;
      
      _.each(profile.controls, (control) => {
        var controlId = control.id;
        var controlTitle = control.title;
  
        var passed = true;
        var skipped = false;
  
        if (!control.results || control.results.length === 0) {
          return;
        }

        var anchorTitle = `${controlId}: ${controlTitle}`;
        var anchorId = anchorTitle.replace(/[^a-zA-Z0-9_]+/g, "-");
        anchorId = anchorId.toLowerCase();    
        const toc = `* [${anchorTitle}](#${anchorId})\n`;
        rendered += `\n## ${anchorTitle}\n\n`;
        var results = "### Results\n";

        _.each(control.results, (result) => {

          results += `1. ${result.status}\n\n`;
          if (result.code_desc) {
            results += "    * Description:\n\n" 
            results += "        ```\n";
            const desc = '        ' + result.code_desc.replace(/\n/g, "\n        ");
            results += `${desc}\n`;
            results += "        ```\n";
          }
          
          if (result.message) {
            results += "    * Message:\n\n" 
            results += "        ```\n";
            const msg = '        ' + result.message.replace(/\n/g, "\n        ")
            results += `${msg}\n`;
            results += "        ```\n";
          }

          var status = result.status;
          if (status === "failed") {
            passed = false;
          } else if (status === "skipped") {
            skipped = true;
          }          
        });
  
        rendered += "### Status: ";
        if (!passed) {
          tocFailed += toc;
          rendered += "**Failed**";
          numFailed++;
        } else {
          if (skipped) {
            tocSkipped += toc;
            rendered += "Skipped";
            numSkipped++;
          } else {
            tocPassed += toc;
            rendered += "Passed";
            numPassed++;
          }
        }

        rendered += `\n\n${results}\n\n`;

        if (control.desc) {
          rendered += `### Description:\n\n${control.desc}\n\n`;
        }

        if (control.refs && control.refs.length > 0) {
          rendered += `### References:\n\n`;

          _.each(control.refs, (ref) => {
            rendered += `1. [${ref.ref}](${ref.url})\n`;
          });  
        }

        rendered += "\n---\n[\[Back to Top\]](#summary)n\n"
      });

      summary += `## Failed: ${numFailed}\n`;

      if (numFailed) {
        summary += tocFailed + "\n";
      }

      summary += `## Passed: ${numPassed}\n`;

      if (numPassed) {
        summary += tocPassed + "\n";
      }      

      summary += `## Skipped: ${numSkipped}\n`;

      if (numSkipped) {
        summary += tocSkipped + "\n";
      }

      intro += `Failed: ${numFailed} • Passed: ${numPassed} • Skipped: ${numSkipped}\n\n`;

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

      var markedUp = marked(rendered);
      var summaryMarkedUp = marked(summary);
      var introMarkedUp = marked(intro);
  
      var header = '<meta name="viewport" content="width=device-width, initial-scale=1">' 
      + '<header>\n'
      + '  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/2.10.0/github-markdown.css">\n'
      + '  <style>\n'
      + '      .markdown-body {\n'
      + '        box-sizing: border-box;\n'
      + '        min-width: 200px;\n'
      + '        max-width: 980px;\n'
      + '        margin: 0 auto;\n'
      + '        padding: 45px;\n'
      + '      }\n'
      + '    \n'
      + '      @media (max-width: 767px) {\n'
      + '        .markdown-body {\n'
      + '          padding: 15px;\n'
      + '        }\n'
      + '      }\n'
      + '    </style>\n'
      + '</header>\n'
      + '<body>\n'
      + '    <article class="markdown-body">\n';
      
      var footer = '</article>\n</body>\n';;
  
      var final = header + introMarkedUp + summaryMarkedUp + markedUp + footer;
  
      fs.writeFile(reportDirName + '/inspec-' + file + '.html', final, (err) => {  
        // throws an error, you could also catch it here
        if (err) throw err;
    
        // success case, the file was saved
        console.log('HTML saved!');
      });      
    });

    


  });

}


module.exports = {
  init: init,
  shutdown: shutdown
};
