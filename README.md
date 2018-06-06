# prometheus_inspec_exporter

## Hello Monitorama!

[Join the "Security Through Observability" Google Group](https://groups.google.com/forum/#!forum/securitythroughobservability) to get updates about this project.

For code/config snippets used in my demo, see this repo: https://github.com/geekdave/monitorama

## What is this?

A Prometheus integration with the [InSpec](https://www.inspec.io/) "Compliance as Code" tool.

## What does it do?

Converts InSpec json reports into Prometheus metrics, so you can monitor your compliance checks using Prometheus and fire alerts if anything falls out of compliance.

## How does it do that?

1. Assumes you have InSpec checks running periodicially as a cron job and outputting to a well-known directory such as `/usr/local/etc/inspec-results`
1. Exposes a `/metrics` endpoint
1. When the metrics endpoint is scraped, checks the pre-configured directory for `*.json` files
1. Parses the json file to determine the name of the inspec profile, the number of passes, failures, and skips, and exposes this data as Prometheus metrics like so:

```
# HELP inspec_checks_total Number of inspec checks
# TYPE inspec_checks_total gauge
inspec_checks_total{profile="ssl-baseline",status="passed"} 6
inspec_checks_total{profile="ssl-baseline",status="failed"} 0
inspec_checks_total{profile="ssl-baseline",status="skipped"} 0
```

## Project status

This project is currently in the early stages and may be rough around the edges.  It may contain bugs.  Please try it out and let us know how we can improve it!  PRs are welcome!

## Usage

### Install InSpec

See: https://www.inspec.io/downloads/

### Set up Cron Job

Run `sudo crontab -e` to set up a recurring job like this:

```
0 * * * * /usr/local/bin/run_inspec.sh
```

Probably hourly is a good place to start, but your needs may vary.  Some InSpec suites may take a couple minutes to run, so it's not recommended to run it more frequently than the duration of the suites.  Otherwise you might run into errors with overlapping checks overwriting each other.

### Create InSpec runner

Create a `run_inspec.sh` script like this:

```
#!/usr/bin/env bash

# Run InSpec results and output to temp file
inspec exec https://github.com/geekdave/monitorama  --reporter json | jq '.' > /tmp/monitorama.json

# Atomically move the temp file to the expected location to avoid reading partially-written results
mv /tmp/monitorama.json /usr/local/etc/inspec-results/monitorama.json
```

### Launch Container

```
sudo docker run \
  -d \
  --rm \
  --name prometheus_inspec_exporter \
  -v /usr/local/etc/inspec-results:/usr/local/etc/inspec-results \
  -v /usr/local/etc/inspec-reports:/usr/local/etc/inspec-reports \
  -p 9207:9207 \
  geekdave/prometheus_inspec_exporter
```

* Change `/usr/local/etc/inspec-results:/usr/local/etc/inspec-results` to reflect `/path/to/your/inspec-results:/usr/local/etc/inspec-results` from your InSpec runner script (above)
* Change `/usr/local/etc/inspec-reports:/usr/local/etc/inspec-reports` to reflect `/path/to/your/inspec-reports:/usr/local/etc/inspec-reports` - Any directory you want this exporter to save your HTML reports into.
* Change `-p 9207:9207` to reflect `-p $PORT_YOU_WANT_TO_EXPOSE:9207`

### Prometheus Scraping

Sample Prometheus config snippet

```
  - job_name: 'inspec'
    scrape_interval: 1m
    scrape_timeout: 1m
    static_configs:
      - targets:
        - 'myhost1.example.com:9207'
        - 'myhost2.example.com:9207'
        - 'myhost3.example.com:9207'
```

See the Prometheus docs for setting up automatic service discovery instead of maintaining a list of static hosts.  

## Alerting

You can then write Prometheus alerts like this:

```
  - alert: ComplianceFailure
    expr: inspec_checks_total{status="failed"} > 0
    labels:
      severity: slack
    annotations:
      identifier: "{{ $labels.profile }} : {{ $labels.instance }}"
      description: "{{ $labels.instance }} has {{ $value }} compliance failures on the {{ $labels.profile }} profile.
```

## Alerting with Report Integration

This exporter saves HTML versions of the full InSpec reports to `/usr/local/etc/inspec-reports` using a custom markdown/HTML format that preserves much more metadata than the out-of-the-box InSpec reports.  

HTML reports will be saved to `/usr/local/etc/inspec-reports` (map it using docker path mapping as defined above).

You can write a script to periodically upload these files to S3 to make them available as click-throughs from your Prometheus alerts as shown below.

TODO: Create automatic support for uploading to S3.

```
  - alert: ComplianceFailure
    expr: inspec_checks_total{status="failed"} > 0
    labels:
      severity: slack
    annotations:
      identifier: "{{ $labels.profile }} : {{ $labels.instance }}"
      description: "{{ $labels.instance }} has {{ $value }} compliance failures on the {{ $labels.profile }} profile. Report and remediation steps: http://glueops-inspec-bucket-results.s3-website-us-east-1.amazonaws.com/{{ $labels.profile }}/{{ $labels.instance }}"
```

## Checking Cron

To make sure that your cron job is running as expected, and correctly refreshing the reports, this exporter also exposes a metric for the last modified time of the json file:

```
# HELP inspec_checks_mtime Last modified time of inspec checks
# TYPE inspec_checks_mtime gauge
inspec_checks_mtime{profile="ssl-baseline"} 1528206609632.9578
```

You can consume it like this:

```
time() - inspec_checks_mtime{instance=~"$instance"} / 1000
```

This will compare the current time with the last modified time, and you could write an alert like:

```
alert: StaleInSpecResults
expr: time() - inspec_checks_mtime{instance=~"$instance"} / 1000 > 7200
labels:
  severity: slack
annotations:
  description: '{{ $labels.instance }} has stale InSpec metrics.'
  summary: Instance {{ $labels.instance }} expected to have InSpec results refreshed every hour, but it has been over 2 hours.  Please check that the cron job is running as expected.
```

## Building a docker container

```
docker build . -t org/containername:tag
```

i.e.

```
docker build . -t geekdave/prometheus_inspec_exporter:latest
```
