'use strict';

var GitLabHandler = require('./lib/GitLabHandler');

var exports = function() {
  this.configure = this.configure.bind(this);
  this.options = this.options.bind(this);
  this.run = this.run.bind(this);
  this.yargs = null;
};

var server = {};

exports.shortDescription = 'Runs a webhook handler and sends updates to gitlab status API.';

exports.help = 'Usage: npm start [args]';
exports.help += '\n';
exports.help += 'Provides a gitlab webhook endpoint.';

exports.options = function(yargs) {
  this.yargs = yargs;
  return yargs
    .describe('help', 'Displays this message.')
    .alias('help', 'h')
    .describe('port', 'The port on which to listen for incoming requests.')
    .alias('port', 'p')
    .describe('gitlab-webhook-path', 'The path at which to listen for webhooks.')
    .alias('gitlab-webhook-path', 'P')
    .describe('gitlab-webhook-secret', 'The webhook secret provided to Gitlab.')
    .alias('gitlab-webhook-secret', 's')
    .describe('gitlab-api-token', 'The API token to use to write to Gitlab.')
    .alias('gitlab-api-token', 'a')
  ;
};

exports.configure = function(config) {
  server = new GitLabHandler(config);
};

exports.run = function(cb) {
  server.start();
};

module.exports = exports;
