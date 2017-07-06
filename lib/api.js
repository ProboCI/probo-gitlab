'use strict';

var util = require('util');
var url = require('url');
var bunyan = require('bunyan');
var Promise = require('bluebird');
var querystring = require('querystring');

/**
 * @class
 * @classdesc Coordinator API client that bypasses the coordinator and uses the container manager and provider handler directly.
 *
 * @param {Object} config - Settings for the API calls
 * @param {string} config.url - URL for the coordinator, including protocol, host, port
 * @param {string} [config.log] - bunyan log instance to use (child will be created and used). If not supplied, a new instance will be created
 * @param {string} [config.protocol=http] - If {@link config.url} is not supplied, protocol for coordinator
 * @param {string} [config.host] - If {@link config.url} is not supplied, host for coordinator
 * @param {string} [config.port] - If {@link config.url} is not supplied, port for coordinator
 */
var API = function(config) {
  if (config.host) {
    config.url = url.format({
      host: config.host,
      port: config.port,
      protocol: config.protocol,
    });
  }

  this.server = {
    url: config.url,
  };

  this.token = config.token;

  if (config.log) {
    this.log = config.log.child({component: 'api-client'});
  }
  else {
    this.log = bunyan.createLogger({name: 'api-client', level: 'debug'});
  }

  this.config = config;

  this.log.info({server: this.server}, 'CM Coordinator API instantiated');
};

/**
 * Return an instance of {@link API} or {@link CMAPI} depending on whether .token is passed in as well. If config.token exists, an instance of {@link CMAPI} is returned
 * @param {Object} config - See {@link API} and {@link CMAPI}
 *
 * @static
 * @return {Cls} - An instantiated API object.
 */
API.getAPI = function(config) {
  var Cls = config.token ? API : require('./cm_api');

  return new Cls(config);
};

API.prototype._http = function(path, method) {
  var fullUrl = util.format('%s%s', this.server.url, path);
  var authorization = util.format('Bearer %s', this.token);
  var requestMethod = (method || 'GET').toLowerCase();
  var request = require('superagent');

  return request[requestMethod](fullUrl).set('Authorization', authorization);
};

API.prototype.submitBuild = function(build, project, cb) {
  var body = {build: build, project: project};
  this._http('/startbuild', 'post')
    .send(body)
    .end(function(err, res) {
      if (err) return cb(err, res && res.body);

      var build = res.body;
      cb(null, build);
    });
};

/**
 * Pretty processes the status update.
 *
 * @param {object} status - The status object.
 * @return {String} - Tranlsates the optional status.action into an icon in the description
 */
API.prototype.formatStatus = function(status) {
  var icons = {running: '▶', pending: '⌛', finished: '■'};
  var icon = icons[status.action];

  if (icon) {
    status.description = `[${icon}] ${status.description}`;
  }

  // we no longer need the .action field
  delete status.action;

  return status;
};


/**
 * Sets or updates the build status by build id and context
 * @param {Object} build - The build object.
 * @param {String} context - The string representing the name of the task.
 * @param {String} status - Whether the build was successful.
 * @param {Function} cb - The callback function.
 */
API.prototype.setBuildStatus = function(build, context, status, cb) {
  status = this.formatStatus(status);

  // Allow contexts with a slash in it, which need to be encoded to not break routing.
  context = querystring.escape(context);

  var self = this;
  this._http('/builds/' + build.id + '/status/' + context, 'post')
    .send(status)
    .end(function(err, res) {
      if (err) {
        self.log.error({err: err, buildId: build.id}, 'An error occurred updating build status');
        return cb && cb(err);
      }

      var updatedStatus = res.body;
      self.log.info({status: updatedStatus}, 'Build status updated for build', build.id);

      if (cb) cb(null, status);
    });
};

/**
 * Looks up project by provider slug ('github') and repo slug ('zanchin/testrepo')
 * Returns a project object if found.
 *
 * @param {Request} request - The request object.
 * @param {Function} cb - The callback to call when completed.
 */
API.prototype.findProjectByRepo = function(request, cb) {
  this._http('/projects')
    .query({
      service: request.service,
      slug: request.slug,
      single: true,
    })
    .end(function(err, res) {
      cb(err, !err && res.body);
    });
};

Promise.promisifyAll(API.prototype);

module.exports = API;
