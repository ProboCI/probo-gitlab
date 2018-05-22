'use strict';
const async = require('async');
const restify = require('restify');
const createWebhookHandler = require('gitlab-webhook-handler');
const bunyan = require('bunyan');
const yaml = require('js-yaml');
const GitLabApi = require('gitlab');
const API = require('./api');
const requestLogger = require('probo-request-logger');

/**
 * Create a queue that only processes one task at a time.
 * A task is simply a function that takes a callback when it's done
 */
let statusUpdateQueue = async.queue(function worker(fn, done) {
  fn(done);
}, 1);

let GitLabHandler = function(options) {

  this.options = options;

  // Bind functions to ensure `this` works for use in callbacks.
  this.start = this.start.bind(this);
  this.fetchProboYamlConfigFromGitLab = this.fetchProboYamlConfigFromGitLab.bind(this);
  this.fetchYamlFromGitLab = this.fetchYamlFromGitLab.bind(this);
  this.errorHandler = this.errorHandler.bind(this);
  this.mergeRequestHandler = this.mergeRequestHandler.bind(this);
  this.getGitLabApi = this.getGitLabApi.bind(this);

  // Instantiate a logger instance.
  const log = bunyan.createLogger({name: 'gitlab-handler',
    level: options.logLevel || 'debug',
    // src: true,
    serializers: {
      err: bunyan.stdSerializers.err,
      req: bunyan.stdSerializers.req,
    },
  });
  let webhookOptions = {
    path: options.webhookPath,
    secret: options.webhookSecret,
  };

  let handler = createWebhookHandler(webhookOptions);
  handler.on('error', this.errorHandler);
  handler.on('merge_request', this.mergeRequestHandler);

  const self = this;

  this.server = restify.createServer({log: log, name: 'Probo GLH'});
  this.server.use(restify.queryParser());

  // Add probo's request logger
  this.server.use(requestLogger({logger: log}));

  // set up request logging
  this.server.use(function(req, res, next) {
    req.log.info({req: req}, 'REQUEST');
    next();
  });
  this.server.on('after', restify.auditLogger({
    log: log,
  }));

  this.server.post(webhookOptions.path, function(req, res, next) {
    handler(req, res, function(error) {
      res.send(400, 'Error processing hook');
      log.error({err: error}, 'Error processing hook');
      next();
    });
  });

  const buildStatusController = function(req, res, next) {
    const payload = req.body;
    req.log.info({payload: payload}, 'REQUEST');

    if (req.params.context) {
      // usually, context will already be part of update, but read it from URL
      // if it's there for compatability
      payload.update.context = req.params.context;
    }

    log.debug({payload: payload}, 'Update payload');

    self.buildStatusUpdateHandler(payload.update, payload.build, function(err, status) {
      if (err) {
        res.send(500, {error: err});
      }
      else {
        res.send(status);
      }
      return next();
    });
  };

  this.server.post('/builds/:bid/status/:context', restify.jsonBodyParser(), buildStatusController);
  this.server.post('/update', restify.jsonBodyParser(), buildStatusController);

  this.log = log;

  this.api = API.getAPI({
    url: this.options.api.url,
    token: this.options.api.token,
    log: this.log,
    // {url, [host|hostname], [protocol], [port]}
    handler: this.options,
  });

  if (!(this.api instanceof API)) {
    log.info('api.token not found, using Container Manager API directly');
  }
};

GitLabHandler.prototype.start = function(done) {
  const self = this;
  this.server.listen({port: self.options.port, host: self.options.hostname || '0.0.0.0'}, function() {
    self.log.info('Now listening on', self.server.url);
    if (done) {
      return done();
    }
  });
};

GitLabHandler.prototype.stop = function(done) {
  const self = this;
  const url = this.server.url;
  this.server.close(function() {
    self.log.info('Stopped', url);
    if (done) {
      done();
    }
  });
};

/**
 * Build options for GitLab api HTTP requests.
 *
 * @param {object} project - A project object.
 * @return {object} An instantiated and configured Gitlab API object.
 */
GitLabHandler.prototype.getGitLabApi = function(project) {
  const self = this;
  let options = {
    // Note that we are not supporting self hosted gitlab atm.
    url: 'https://gitlab.com',
  };

  if (project.service_auth) {
    options.oauth_token = project.service_auth.token;
  }
  else {
    options.token = this.options.gitLabToken;
  }

  const gitlab = new GitLabApi(options);
  return gitlab;
};

/**
 * Error handler for Gitlab webhooks.
 *
 * @param {Error} error - The error that occurred and is being handled.
 */
GitLabHandler.prototype.errorHandler = function(error) {
  this.log.error({err: error}, 'An error occurred.');
};

GitLabHandler.prototype.mergeRequestHandler = function(event, done) {
  // enqueue the event to be processed...
  const self = this;

  this.log.info('Gitlab Pull request ' + event.payload.object_attributes.id + ' received');

  if (event.payload.object_attributes.state !== 'opened') {
    this.log.info(`Gitlab Merge request ${event.payload.object_attributes.id} ${event.payload.object_kind} ignored`);
    return done();
  }

  var request = {
    // Also in event.event.
    type: 'pull_request',
    service: 'gitlab',
    branch: event.payload.object_attributes.source_branch,
    branch_html_url: event.payload.project.web_url + '/tree/' + event.payload.object_attributes.source_branch,
    slug: event.payload.project.path_with_namespace,
    owner: event.payload.project.namespace,
    repo: event.payload.project.name,
    repo_id: event.payload.object_attributes.target_project_id,
    sha: event.payload.object_attributes.last_commit.id,
    commit_url: event.payload.object_attributes.last_commit.url,
    pull_request: event.payload.object_attributes.iid,
    pull_request_id: event.payload.object_attributes.id,
    pull_request_name: event.payload.object_attributes.title,
    pull_request_description: event.payload.object_attributes.description,
    pull_request_html_url: event.payload.object_attributes.source.web_url + '/merge_requests/' + event.payload.object_attributes.iid,
    payload: event.payload,
  };

  // Build comes back with an embedded .project key.
  // It's not necessary to do anything here, build status updates will come asyncronously.
  this.processRequest(request, function(error, build) {
    self.log.info({type: request.type, slug: request.slug, err: error}, 'request processed');
    if (done) {
      return done(error, build);
    }
  });
};

/**
 * Called when an build status updates
 *
 * @param {object} update - The update object.
 * @param {string} update.state: "status of build",
 * @param {string} update.description - The text discription of the build state.
 * @param {string} update.context - The context used to differentiate this update from other services and steps.
 * @param {string} update.target_url: The url to link to from the status update.
 * @param {object} build - The full build object.
 * @param {object} build.project - The embedded project object.
 * @param {function} done - The callback to be called after the update is performed.
 */
GitLabHandler.prototype.buildStatusUpdateHandler = function(update, build, done) {
  const self = this;
  self.log.info({update: update, build_id: build.id}, 'Got build status update');

  // Create a mapping of states that Gitlab accepts
  const stateMap = {
    running: 'pending',
    pending: 'pending',
    success: 'success',
    error: 'failure',
  };

  let statusInfo = {
    // Can be one of pending, success, error, or failure.
    state: stateMap[update.state],
    description: update.description.substring(0, 140),
    context: update.context,
    target_url: update.target_url,
  };

  const task = this.postStatusToGitLab.bind(this, build.project, build.commit.ref, statusInfo);
  statusUpdateQueue.push(task, function(error) {
    if (error) {
      self.log.error({err: error, build_id: build.id}, 'An error occurred posting status to GitLab');
      return done(error, statusInfo);
    }

    self.log.info(statusInfo, 'Posted status to GitLab for', build.project.slug, build.commit.ref);
    done(null, statusInfo);
  });
};

/**
 * @param {object} request - The incoming hook request data.
 * @param {string} request.type - The type of request to process (eg pull_request).
 * @param {string} request.service - The service to be checked (always gitlab in this handler).
 * @param {string} request.slug - The identifier for the repo (repository.full_name from the gitlab api).
 * @param {string} request.event - The entire event payload from the gitlab api call.
 * @param {function} done - The callback to call when finished.
 */
GitLabHandler.prototype.processRequest = function(request, done) {
  const self = this;
  self.log.info({type: request.type, id: request.id}, 'Processing request');

  this.api.findProjectByRepo(request, function(error, project) {
    if (error || !project) {
      return self.log.info({error}, `Project for gitlab project ${request.slug} not found`);
    }

    self.log.info({project: project}, 'Found project for PR');

    self.fetchProboYamlConfigFromGitLab(project, request.sha, function(error, config) {
      let build;

      if (error) {
        self.log.error({err: error}, 'Problem fetching Probo Yaml Config file');

        // If we can't find a yaml file we should error.
        build = {
          commit: {ref: request.sha},
          project: project,
        };
        const update = {
          state: 'failure',
          description: error.message,
          context: 'ProboCI/env',
        };
        return self.buildStatusUpdateHandler(update, build, done);
      }

      self.log.info({config: config}, 'Probo Yaml Config file');

      build = {
        commit: {
          ref: request.sha,
          htmlUrl: request.commit_url,
        },
        pullRequest: {
          number: request.pull_request + '',
          name: request.pull_request_name,
          description: request.pull_request_description,
          htmlUrl: request.pull_request_html_url,
        },
        branch: {
          name: request.branch,
          htmlUrl: request.branch_html_url,
        },
        config: config,
        request: request,
      };

      self.api.submitBuild(build, project, function(err, submittedBuild) {
        if (err) {
          // TODO: save the PR if submitting it fails (though logging it here might be ok)
          self.log.error({err: err, request: request, build: build, response: submittedBuild}, 'Problem submitting build');
          return done && done(err);
        }

        self.log.info({build: submittedBuild}, 'Submitted build');

        done(null, submittedBuild);
      });

    });
  });
};

/**
 * Posts status updates to Gitlab.
 *
 * @param {object} project - The project object to post the status for.
 * @param {string} sha - The git commit id that we are posting a status for.
 * @param {string} statusInfo - This should be the status message to post to GitLab. See http://docs.gitlab.com/ce/api/commits.html#post-the-build-status-to-a-commit
 * @param {function} done - The callback to call when the status has been updated.
 */
GitLabHandler.prototype.postStatusToGitLab = function(project, sha, statusInfo, done) {
  const self = this;
  const gitlab = self.getGitLabApi(project);

  statusInfo.user = project.owner;
  statusInfo.repo = project.repo;
  statusInfo.sha = sha;

  // Note: the gitlab plugin doesn't directly support commit statuses
  // but the api does so we can use the plugin to post to gitlab.
  gitlab.projects.post(`projects/${project.provider_id}/statuses/${sha}`, statusInfo, function(error, body) {
    done(error, body);
  });
};

 /**
  * Fetches configuration from a .probo.yml file in the gitlab repo.
  *
  * @param {object} project - The project object.
  * @param {string} sha - The git commit id to fetch the .probo.yaml from.
  * @param {function} done - The callback to call upon error/completion.
  */
GitLabHandler.prototype.fetchProboYamlConfigFromGitLab = function(project, sha, done) {
  const self = this;
  const gitlab = this.getGitLabApi(project);

  self.fetchYamlFromGitLab('.probo.yml', sha, project, function(error, yaml) {
    if (error) {
      done(error);
    }
    if (!yaml) {
      self.fetchYamlFromGitLab('.probo.yaml', sha, project, function(error, yaml) {
        if (error) {
          done(error);
        }
        if (yaml) {
          return done(null, yaml);
        }
        else {
          return done(new Error('No .probo.yml file was found.'));
        }
      });
    }
    return done(null, yaml);
  });
};

/**
 * Fetches a file from a .probo.yml file in the gitlab repo.
 *
 * @param {string} path - The path of the file to fetch.
 * @param {string} sha - The git commit id to fetch the .probo.yaml from.
 * @param {object} project - The project object.
 * @param {function} done - The callback to call upon error/completion.
 */
GitLabHandler.prototype.fetchYamlFromGitLab = function(path, sha, project, done) {
  const self = this;
  const gitlab = this.getGitLabApi(project);

  gitlab.projects.repository.showFile(project.provider_id, { ref: sha, file_path: path }, function(file) {
    if (file) {
      let content;
      let settings;
      try {
        content = new Buffer(file.content, 'base64');
        yaml = yaml.safeLoad(content.toString('utf8'));
      }
      catch (e) {
        return done(new Error(`Failed to parse ${file.path}:` + e.message));
      }
    }
    done(null, yaml);
  });
};

module.exports = GitLabHandler;
