'use strict';

const { Gitlab } = require('gitlab');
const yaml = require('js-yaml');

class GitLab {

  constructor(config) {
    this.config = config;
  }

  /**
   * Builds options for GitLab API and returns a client object.
   *
   * @param {object} project - A project object.
   * @return {object} - An instantiated and configured Gitlab client object.
   */
  getApi(project) {
    let options = {
      // Note that we are not supporting self hosted gitlab atm.
      host: 'https://gitlab.com',
    };

    if (project.service_auth) {
      options.oauthToken = project.service_auth.token;
    }
    else {
      options.token = this.config.gitLabToken;
    }

    return new Gitlab(options);
  }

  /**
   * Fetches configuration from a .probo.yml file in the gitlab repo.
   *
   * @param {object} project - The project object.
   * @param {string} sha - The git commit id to fetch the .probo.yaml from.
   * @param {function} cb - The callback to call upon error/completion.
   */
  fetchProboYamlConfig(project, sha, cb) {
    this.fetchYamlFile('.probo.yml', sha, project, (error, yaml) => {
      if (error) {
        if (!error.response || error.response.status !== 404) {
          return cb(error);
        }
      }

      if (!yaml) {
        this.fetchYamlFile('.probo.yaml', sha, project, (error, yaml) => {
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
   * @param {string} path - The path of the file to fetch.
   * @param {string} sha - The git commit id to fetch the .probo.yaml from.
   * @param {object} project - The project object.
   * @param {function} cb - The callback to call upon error/completion.
   */
  fetchYamlFile(path, sha, project, cb) {
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
   * @param {object} project - The project object to post the status for.
   * @param {string} sha - The git commit id that we are posting a status for.
   * @param {string} statusInfo - This should be the status message to post to GitLab. See http://docs.gitlab.com/ce/api/commits.html#post-the-build-status-to-a-commit
   * @param {function} cb - The callback to call when the status has been updated.
   */
  postStatusToGitLab(project, sha, statusInfo, cb) {
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
        if (err.description.includes('Cannot transition status via :run from :running')) {
          return cb();
        }

        return cb(err);
      });
  }

}

module.exports = GitLab;