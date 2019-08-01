'use strict';

const { Gitlab } = require('gitlab');
const yaml = require('js-yaml');

class GitLab {

  static BASE_URL = 'https://gitlab.com';

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Builds options for GitLab API and returns a client object.
   *
   * @param {Object.<string, string>} project - A project object.
   * @return {import("gitlab")} The GitLab client object.
   */
  getApi(project) {
    let options = {
      host: project.provider.baseUrl || GitLab.BASE_URL,
    };

    if (project.service_auth) {
      options.oauthToken = project.service_auth.token;
    }
    else {
      options.token = this.config.gitLabToken;
    }
    console.log("OPTIONS", options);
    return new Gitlab(options);
  }

  /**
   * Fetches configuration from a .probo.yml file in the GitLab repo.
   *
   * @param {Object.<string, string>} project - The project object.
   * @param {string} sha - The git commit id to fetch the .probo.yaml from.
   * @param {(err: Error, [res]) => void} cb - The callback to call upon error/completion.
   */
  fetchProboYamlConfig(project, sha, cb) {
    this.fetchYamlFile(project, sha, '.probo.yml', (error, yaml) => {
      if (error) {
        if (!error.response || error.response.status !== 404) {
          return cb(error);
        }
      }

      if (!yaml) {
        this.fetchYamlFile(project, sha, '.probo.yaml', (error, yaml) => {
          if (error) {
            return cb(error);
          }
          if (yaml) {
            return cb(null, yaml);
          }
          else {
            return cb(new Error('No .probo.yml file was found.'));
          }
        });
      }

      return cb(null, yaml);
    });
  }

  /**
   * Fetches a YAML file from a GitLab repo.
   *
   * @param {Object.<string, any>} project - The project object.
   * @param {string} sha - The git commit id to fetch the .probo.yaml from.
   * @param {string} path - The path of the file to fetch.
   * @param {(err: Error, [res]) => void} cb - The callback to call upon error/completion.
   */
  fetchYamlFile(project, sha, path, cb) {
    const gitlab = this.getApi(project);

    gitlab.RepositoryFiles.show(project.provider_id, path, sha)
      .then(file => {
        let content;
        let settings;
        if (file) {
          try {
            content = new Buffer.from(file.content, 'base64');
            settings = yaml.safeLoad(content.toString('utf8'));
          }
          catch (e) {
            return cb(new Error(`Failed to parse ${file.file_path}: ${e.message}`));
          }
        }

        cb(null, settings);
      })
      .catch(err => cb(err));
  }

  /**
   * Posts status updates to a GitLab pipeline job.
   *
   * @param {Object.<string, any>} project - The project object to post the status for.
   * @param {string} sha - The git commit id that we are posting a status for.
   * @param {string} statusInfo - This should be the status message to post to GitLab. See http://docs.gitlab.com/ce/api/commits.html#post-the-build-status-to-a-commit
   * @param {(err: Error, [res]) => void} cb - The callback to call when the status has been updated.
   */
  postStatus(project, sha, statusInfo, cb) {
    const gitlab = this.getApi(project);

    statusInfo.user = project.owner;
    statusInfo.repo = project.repo;
    statusInfo.sha = sha;

    gitlab.Projects.statuses(project.provider_id, sha, statusInfo.state, statusInfo)
      .then(function(result) {
        cb(null, result);
      })
      .catch(err => {
        // This happens if we update the state with the same state and isn't a problem.
        if (err.description.includes('Cannot transition status via :run from :running')
           || err.description.includes('Cannot transition status via :enqueue from :running')) {
          return cb();
        }

        this.logger.error({err: err, statusInfo: statusInfo}, 'Error when posting to status to GitLab');

        return cb(err);
      });
  }

  /**
   * Gets information on a merge request.
   *
   * @param {Object.<string, any>} query - The parameters for the request.
   * @param {string} query.projectId - The GitLab project id of the merge request.
   * @param {number} query.mergeRequestId - The merge request number/id.
   * @param {string} query.token - The user token used for authentication.
   * @param {string} query.baseUrl - The base URL if repo is on a self-hosted instance.
   * @return {Promise<Object.<string, string | number>>} - A promise.
   */
  async getMergeRequest(query) {
    let project = {
      service_auth: {
        token: query.token
      },
      provider: {
        baseUrl: query.baseUrl,
      },
    };

    const gitlab = this.getApi(project);

    return gitlab.MergeRequests.show(query.projectId, query.mergeRequestId)
      .then(result => {
        let mergeRequest = {
          id: result.id,
          number: result.id,
          state: (result.state === 'opened' || result.state === 'locked') ? 'open' : 'closed',
          url: result.web_url,
          title: result.title,
          userName: result.author.username,
          userId: result.author.id,
        };

        return Promise.resolve(mergeRequest);
      })
      .catch(err => {
        this.logger.error({err: err}, 'Error getting information on merge request');

        return Promise.reject(err);
      });
  }

}

module.exports = GitLab;
