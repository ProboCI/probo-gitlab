'use strict';

const request = require('sync-request');
const getCurrentLine = require('get-current-line').default;
const mail = require('./mail');

class Tokens {

  constructor(config, logger, apiLogger) {
    this.config = config;
    this.logger = logger;
    this.apiLogger = logger;
    this.mail = new mail(config, logger);
  }

  checkTokens(project) {
    let iteration = 0;
    let statusCode = 0;

    do {
      iteration++;
      const tokenCheck = request('GET', 'https://gitlab.com/api/v4/projects', {
        headers: {
          'authorization': 'Bearer ' + project.service_auth.token,
        },
      });
      this.apiLogger.trace({statusCode: tokenCheck.statusCode, tokens: project.service_auth}, 'GitLab Token Check: ' + iteration);
      statusCode = tokenCheck.statusCode;
    } while (statusCode != 200 && iteration < 5);

    if (statusCode != 200) {
      // Get the refresh token directly from GitLab using our clientKey and
      // refreshToken. We need to wrap this in a try-catch because if we try
      // to get the token for an expired refresh token, we need another course
      // of action.
      try {
        const requestBody = 'client_id=' + this.config.clientKey + '&refresh_token=' + project.service_auth.refreshToken + '&grant_type=refresh_token&redirect_uri=' + this.config.callbackURL;
        const tokens = request('POST', 'https://gitlab.com/oauth/token', {
          body: requestBody,
        });
        const responseBody = JSON.parse(tokens.getBody());
      
        this.apiLogger.trace({responseBody: responseBody}, '-->Response Body');
        this.apiLogger.trace({project: project}, '-->Project Object');

        // Take our new tokens and save them.
        const updateTokens = request('POST', this.config.api.url + '/projects/tokens', {
          headers: {
            oid: project.organizationId,
            token: responseBody.access_token,
            refreshtoken: responseBody.refresh_token,
            authorization: 'Bearer ' + this.config.api.token,
          },
        });

        const newTokens = JSON.parse(updateTokens.body);
        this.apiLogger.trace({newTokens: newTokens}, 'New OAuth tokens For Project');
        const updatedTokens = {
          token: newTokens.access_token,
          refreshToken: newTokens.refresh_token,
        };
        return updatedTokens;
      } catch (e) {
        this.apiLogger.trace({error: e}, 'Error trace of token refresh');
        const vars = {
          error_message: 'The access token could not be successfully refreshed. ',
          subject: 'ProboCI Error: GitLab Access Token Refresh',
          stack: getCurrentLine(),
          email_type: 'Error',
          email_system: 'Token Checking',
          error: e,
        };
        this.mail.send(vars);
        return project.service_auth;
      }
    } else {
      return project.service_auth;
    }
  }
}

module.exports = Tokens;
