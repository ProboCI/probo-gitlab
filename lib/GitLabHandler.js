'use strict';

const async = require('async');
const bunyan = require('bunyan');
const createWebhookHandler = require('gitlab-webhook-handler');
const requestLogger = require('probo-request-logger');
const restify = require('restify');

const API = require('./api');
const GitLab = require('./GitLab');

/**
 * Create a queue that only processes one task at a time.
 * A task is simply a function that takes a callback when it's done
 */
let statusUpdateQueue = async.queue(function worker(fn, cb) {
  fn(cb);
}, 1);

class GitLabHandler {

  constructor(options) {

    this.config = options;

    // Instantiate a logger instance.
    this.logger = bunyan.createLogger({
      name: 'gitlab-handler',
      level: options.logLevel || 'debug',
      // src: true,
      serializers: {
        err: bunyan.stdSerializers.err,
        req: bunyan.stdSerializers.req,
      },
    });

    this.gitlab = new GitLab(this.config, this.logger);

    this.webhookOptions = {
      path: options.webhookPath,
      secret: options.webhookSecret,
    };

    // Sets up the path for the GitLab webhooks.
    this.handler = this._createWebhookHandler();

    this.server = restify.createServer({log: this.logger, name: 'Probo GLH'});

    // Set ups the server and routes for the Probo GitLab Handler.
    this._setupServer();
    this._setupRoutes();

    this.api = API.getAPI({
      url: this.config.api.url,
      token: this.config.api.token,
      log: this.logger,
      // {url, [host|hostname], [protocol], [port]}
      handler: this.config,
    });
  }

  /**
   * Starts the server.
   *
   * @param {function} cb - The callback function
   */
  start(cb) {
    this.server.listen({port: this.config.port, host: this.config.hostname || '0.0.0.0'}, () => {
      this.logger.info('Now listening on', this.server.url);

      if (cb) cb();
    });
  }

  /**
   * Closes the server.
   *
   * @param {function} cb - The callback function
   */
  close(cb) {
    const url = this.server.url;
    this.server.close(() => {
      this.logger.info('Stopped', url);

      if (cb) cb();
    });
  }

  /**
   * Creates a GitLab Webhook Handler.
   *
   * @return {object} - An initialized webhook handler server.
   */
  _createWebhookHandler() {
    let handler = createWebhookHandler(this.webhookOptions);

    handler.on('error', error => {
      this.logger.error({err: error}, 'An error occurred.');
    });

    handler.on('merge_request', this.mergeRequestHandler.bind(this));
    handler.on('push', this.pushHandler.bind(this));

    return handler;
  }

  /**
   * Sets up the server for the Probo GitLab Handler.
   */
  _setupServer() {
    this.server.use(restify.plugins.queryParser());

    // Adds Probo's request logger
    this.server.use(requestLogger({logger: this.logger}));

    // Sets up request logging
    this.server.use((req, res, next) => {
      this.logger.info({req: req}, 'REQUEST');
      next();
    });

    this.server.on('after', restify.plugins.auditLogger({
      log: this.logger,
      event: 'after'
    }));
  }

  /**
   * Sets up the routes for the Probo GitLab Handler.
   *
   * These routes corresponds to the webhook handler and the status update
   * paths.
   */
  _setupRoutes() {
    // For requests to webhook handler path, make the webhook handler take care
    // of the requests.
    this.server.post(this.webhookOptions.path, (req, res, next) => {
      this.handler(req, res, error => {
        res.send(400, 'Error processing hook');
        this.logger.error({err: error}, 'Error processing hook');

        next();
      });
    });

    this.server.post('/builds/:bid/status/:context', restify.plugins.jsonBodyParser(), this.buildStatusController.bind(this));
    this.server.post('/update', restify.plugins.jsonBodyParser(), this.buildStatusController.bind(this));
    this.server.post('/builds/hash', restify.plugins.jsonBodyParser(), this.hashBuildController.bind(this));

    this.server.get('/pull-request/:owner/:repo/:pullRequestNumber', this.getPullRequest.bind(this));
  }

  /**
   * Called when user wants to create a build based on a commit hash.
   *
   * This controller gets info about the commit and submits a build request.
   *
   * @param {import('restify').Request} req - The request to the server.
   * @param {import('restify').Response} res - The server response
   * @param {import('restify').Next} next - Next handler in the chain.
   */
  hashBuildController(req, res, next) {

    this.logger.info({
      owner: req.body.project.owner,
      repo: req.body.project.repo,
      sha: req.body.sha,
    }, 'Processing build for commit hash');

    const project = req.body.project;
    const sha = req.body.sha;

    // The commit info is used to fill some info about the build when sending
    // a build request to coordinator.
    this.gitlab.getCommit(project, sha, (err, commit) => {
      if (err) {
        this.logger.error({err: err}, 'Problem getting commit info.');
        res.send(500, {error: err});

        return next();
      }

      this.handleHashBuild(commit, project, sha, (err, build) => {
        if (err) {
          this.logger.error({err: err}, 'Problem processing build for commit hash.');
          res.send(500, {error: err});

          return next();
        }

        res.json(build);
        return next();
      });
    });

  }

  /**
   * Fetches the yaml configuration and submits build request.
   *
   * @param {Object.<string, string>} commit - The info on the commit.
   * @param {Object.<string, any>} project - The project object.
   * @param {string} sha - The hash of the commit to retrieve.
   * @param {(error: Error, [build]: Object.<string, any>)} cb - The callback
   *   function.
   */
  handleHashBuild(commit, project, sha, cb) {
    this.gitlab.fetchProboYamlConfig(project, sha, (error, config) => {
      if (error) {
        this.logger.error({err: error}, 'Problem fetching Probo Yaml Config file');

        return cb(error);
      }

      const request = {
        sha: commit.sha,
        commit_url: commit.html_url,
        name: commit.message,
        type: 'hash',
      };

      this.submitBuild(request, project, config, cb);
    });
  }

  /**
   * Called on a build status update event.
   *
   * @param {object} req - The request to the server.
   * @param {object} res - The server response
   * @param {object} next - The chain of handlers for the request.
   */
  buildStatusController(req, res, next) {
    const payload = req.body;
    req.log.info({payload: payload}, 'REQUEST');

    if (req.params.context) {
      // usually, context will already be part of update, but read it from URL
      // if it's there for compatability
      payload.update.context = req.params.context;
    }

    this.logger.debug({payload: payload}, 'Update payload');

    this.buildStatusUpdateHandler(payload.update, payload.build, (err, status) => {
      if (err) {
        res.send(500, {error: err});
      }
      else {
        res.send(status);
      }

      return next();
    });
  }

  /**
   * The handler for merge request events from GitLab webhooks.
   *
   * @param {object} event - The merge request event.
   * @param {function} cb - The callback to be called after the update is performed.
   */
  mergeRequestHandler(event, cb) {

    const payload = event.payload;

    this.logger.info(`Gitlab merge request ${payload.object_attributes.id} received`);

    if (payload.object_attributes.state !== 'opened') {
      this.logger.info(`Gitlab merge request ${payload.object_attributes.id} ${payload.object_kind} ignored`);
      return cb && cb();
    }

    let request = {
      // Also in event.event.
      type: 'pull_request',
      name: payload.object_attributes.title,
      service: 'gitlab',
      branch: {
        name: payload.object_attributes.source_branch,
        html_url: `${payload.project.web_url}/tree/${payload.object_attributes.source_branch}`,
      },
      pull_request: {
        number: payload.object_attributes.iid,
        id: payload.object_attributes.id,
        name: payload.object_attributes.title,
        description: payload.object_attributes.description,
        html_url: `${payload.object_attributes.source.web_url}/merge_requests/${payload.object_attributes.iid}`,
      },
      slug: payload.project.path_with_namespace,
      owner: payload.project.namespace,
      repo: payload.project.name,
      repo_id: payload.object_attributes.target_project_id,
      sha: payload.object_attributes.last_commit.id,
      commit_url: payload.object_attributes.last_commit.url,
    };

    this.processWebhookEvent(request, (error, build) => {
      this.logger.info({type: request.type, slug: request.slug, err: error}, 'Merge request processed');

      return cb && cb(error, build);
    });

  }

  /**
   * The handler for push events from GitHub webhooks.
   *
   * @param {Object.<string, any>} event - The push event.
   * @param {(err: Error, [build]) => void} cb cb - The callback to be called
   *   after the update is performed.
   */
  pushHandler(event, cb) {
    this.logger.info('GitLab push event received');

    const payload = event.payload;
    const branch = payload.ref.replace('refs/heads/', '');

    const request = {
      type: 'branch',
      name: `Branch ${branch}`,
      service: 'gitlab',
      branch: {
        name: branch,
        html_url: `${payload.project.web_url}/tree/${branch}`,
      },
      slug: payload.project.path_with_namespace,
      owner: payload.project.namespace,
      repo: payload.project.name,
      repo_id: payload.project.id,
      sha: payload.after,
      commit_url: `${payload.project.web_url}/commit/${payload.after}`,
    };

    this.processWebhookEvent(request, (error, build) => {
      this.logger.info({type: request.type, slug: request.slug, err: error}, 'Push event processed');

      return cb && cb(error, build);
    });
  }

  /**
   * Update the status of a pipeline job on GitLab.
   *
   * @param {object} update - The update object.
   * @param {string} update.state: "status of build",
   * @param {string} update.description - The text discription of the build state.
   * @param {string} update.context - The context used to differentiate this update from other services and steps.
   * @param {string} update.target_url: The url to link to from the status update.
   * @param {object} build - The full build object.
   * @param {object} build.project - The embedded project object.
   * @param {function} cb - The callback to be called after the update is performed.
   */
  buildStatusUpdateHandler(update, build, cb) {
    this.logger.info({update: update, build_id: build.id}, 'Got build status update');

    // Create a mapping of states that Gitlab accepts
    const stateMap = {
      running: 'running',
      pending: 'pending',
      success: 'success',
      error: 'failed',
      failure: 'failed',
    };

    let statusInfo = {
      // Can be one of pending, success, error, or failure.
      state: stateMap[update.state],
      description: update.description.substring(0, 140),
      context: update.context,
      target_url: update.target_url,
    };

    const task = this.gitlab.postStatusToGitLab.bind(this.gitlab, build.project, build.commit.ref, statusInfo);
    statusUpdateQueue.push(task, error => {
      if (error) {
        this.logger.error({err: error, build_id: build.id}, 'An error occurred posting status to GitLab');
        return cb(error, statusInfo);
      }

      this.logger.info(statusInfo, 'Posted status to GitLab for', build.project.slug, build.commit.ref);
      cb(null, statusInfo);
    });
  }

  /**
   * Processes a merge request and submits a Probo build.
   *
   * @param {Object.<string, any>} request - The incoming hook request data.
   * @param {string} request.type - The type of request to process (eg
   *   pull_request).
   * @param {string} request.slug - The identifier for the repo.
   * @param {(err: Error, [build]) => void} cb - The callback to call when
   *   finished.
   */
  processWebhookEvent(request, cb) {
    console.log(request);
    this.logger.info({type: request.type, id: request.id}, 'Processing merge request');

    this.api.findProjectByRepo(request, (error, project) => {
      if (error || !project) {
        this.logger.error({error}, `Project for gitlab project ${request.slug} not found`);

        return cb(error || new Error('Project not found'));
      }

      // If push event is for a branch and the branch is not enabled, do not
      // build.
      if (request.type === 'branch') {
        if (!project.branches || !project.branches[request.branch.name]) {
          return cb(null, null);
        }
      }

      this.processBuild(project, request, cb);
    });
  }

  /**
   * Process a build request for a project.
   *
   * @param {Object.<string, any>} project - The project object.
   * @param {Object.<string, any>} request - The incoming hook request data.
   * @param {(err: Error, [build]) => void} cb - The callback to call when
   *   finished.
   */
  processBuild(project, request, cb) {
    this.gitlab.fetchProboYamlConfig(project, request.sha, (error, config) => {
      let build = {};

      if (error) {
        this.logger.error({err: error}, 'Problem fetching Probo Yaml Config file');

        // If we can't find a yaml file we should error.
        build = {
          commit: {ref: request.sha},
          project: project,
        };
        const update = {
          state: 'error',
          description: error.message,
          context: 'ProboCI/env',
        };

        return this.buildStatusUpdateHandler(update, build, cb);
      }

      this.logger.info({config: config}, 'Probo Yaml Config file');

      this.submitBuild(request, project, config, cb);
    });
  }

  /**
   * Called on a get PR request. Returns a PR info.
   *
   * @param {object} req - The request to the server.
   * @param {object} res - The server response
   * @param {object} next - The chain of handlers for the request.
   */
  getPullRequest(req, res, next) {

    const opts = {
      provider_id: req.query.provider_id,
      id: req.params.pullRequestNumber,
      token: req.query.token,
    };

    this.gitlab.getMergeRequest(opts)
      .then(mergeRequest => {
        res.json(mergeRequest);

        next();
      })
      .catch(err => {
        res.json(500, err);

        return next(err);
      });
  }

  /**
   * Submits a Probo build request.
   *
   * @param {object} request - Information on the repo/branch/commit to build.
   * @param {object} project - The project to build.
   * @param {string} config - The probo YAML config file.
   * @param {function} cb - The callback to call when finished.
   */
  submitBuild(request, project, config, cb) {
    let build = {
      commit: {
        ref: request.sha,
        htmlUrl: request.commit_url,
      },
      name: request.name,
      type: request.type,
      config: config,
    };

    // If build is for a pull request or push, branch information is passed.
    if (request.branch) {
      build.branch = {
        name: request.branch.name,
        htmlUrl: request.branch.html_url,
      };
    }

    // If build is for a pull request, extra information is passed.
    if (request.pull_request) {
      build.pullRequest = {
        number: request.pull_request.number + '',
        name: request.pull_request.name,
        description: request.pull_request.description,
        htmlUrl: request.pull_request.html_url,
      };
    }

    this.api.submitBuild(build, project, (err, submittedBuild) => {
      if (err) {
        // TODO: save the PR if submitting it fails (though logging it here might be ok)
        this.logger.error({
          err: err,
          request: request,
          build: build,
          response: submittedBuild
        }, 'Problem submitting build');
        return cb && cb(err);
      }

      this.logger.info({build: submittedBuild}, 'Submitted build');

      cb(null, submittedBuild);
    });
  }

}

module.exports = GitLabHandler;
