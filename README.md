# prometheus_inspec_exporter

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

## Usage

### Set up Cron Job

Run `sudo crontab -e` to set up a recurring job like this:

```
*/1 * * * * /usr/local/bin/run_inspec.sh
```

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

sudo docker run \
  -d \
  --rm \
  --name prometheus_inspec_exporter \
  -v /usr/local/etc/inspec-results:/usr/local/etc/inspec-results \
  -p 9207:9207 \
  geekdave/prometheus_inspec_exporter
```

* Change `/usr/local/etc/inspec-results:/usr/local/etc/inspec-results` to reflect `/path/to/your/inspec-results:/usr/local/etc/inspec-results`


## Alerting

You can then write Prometheus alerts like this:

```
alert: InsecureTLS
expr: inspec_checks_total{profile="ssl-baseline",status="failed"} > 0
labels:
  severity: slack
annotations:
  description: '{{ $labels.instance }} is using an insecure TLS version.'
  summary: Instance {{ $labels.instance }} is using an insecure TLS version.
``

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
expr: time() - inspec_checks_mtime{instance=~"$instance"} / 1000 > 120
labels:
  severity: slack
annotations:
  description: '{{ $labels.instance }} has stale InSpec metrics.'
  summary: Instance {{ $labels.instance }} expected to have InSpec results refreshed every 60 seconds, but it has been over 120 seconds.  Please check that the cron job is running as expected.
``

