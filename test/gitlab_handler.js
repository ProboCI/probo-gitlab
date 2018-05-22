'use strict';

/* eslint no-unused-expressions: 0 */
var util = require('util');
var request = require('request');
var should = require('should');

var sinon = require('sinon');
var nock = require('nock');
var nockout = require('./__nockout');

var GitLabHandler = require('../lib/GitLabHandler');

var config = {
  webhookPath: '/glh',
  webhookSecret: 'secret',
  port: 0,
  api: {
    url: 'http://localhost:3000',
    token: 'token',
  },
};
var glhServer = new GitLabHandler(config);

function http(path, glh) {
  glh = glh || glhServer;
  let options = {
    url: util.format('%s%s', glh.server.url, path),
    json: true,
  };

  return request.defaults(options);
}

describe('GitLabHandler', function() {
  describe('webhooks', function() {
    before('start GitLabHandler server', function(done) {
      glhServer.start(done);
    });

    after('stop GitLabHandler server', function(done) {
      glhServer.stop(done);
    });

    describe('pull', function() {
      let nocker;
      beforeEach('nock out network calls', function() {
        nocker = initNock();
      });

      afterEach('reset network mocks', function() {
        nocker.cleanup();
      });

      it('is routed', function(done) {
        let payload = require('./fixtures/pull_payload');
        let headers = {
          'X-GitLab-Token': 'secret',
          'X-GitLab-Event': 'Merge Request Hook',
        };
        http(config.webhookPath)
        .post({body: payload, headers: headers}, function(err, res, body) {
          // handles push by returning OK and doing nothing else
          body.should.eql({ok: true});
          should.not.exist(err);

          // TODO: WAT? why isn't this a set of async callbacks so we actually know when it's done?!
          // pause for a little before finishing to allow push processing to run
          // and hit all the GL nocked endpoints
          setTimeout(done, 200);
        });
      });


      it('is handled', function(done) {
        let payload = require('./fixtures/pull_payload');

        // fire off handler event
        let event = {
          event: 'merge_request',
          id: 'a60aa880-df33-11e4-857c-eca3ec12497c',
          url: '/glh',
          payload: payload,
        };
        glhServer.mergeRequestHandler(event, function(err, build) {
          should.not.exist(err);
          build.should.be.a.object;
          build.id.should.eql('build1');
          build.projectId.should.eql('1234');
          build.commit.should.be.a.object;
          build.commit.ref.should.eql('9dd7d8b3ccf6cdecc86920535e52c4d50da7bd64');
          build.pullRequest.should.be.a.object;
          build.pullRequest.number.should.eql('1');
          build.branch.should.be.a.object;
          build.branch.name.should.eql('feature');

          build.config.should.eql({
            fetcher_config: {
              'environment.remote': 'dev',
              'info_fetcher.class': 'FetcherServices\\InfoFetcher\\FetcherServices',
              'info_fetcher.config': {
                host: 'https://extranet.zivtech.com',
              },
              'name': 'awesome',
            },
            image: 'lepew/ubuntu-14.04-lamp',
            provisioner: 'fetcher',
          });

          build.project.should.eql({
            id: '1234',
              // provider_id: 33704441,
            owner: 'proboci',
            repo: 'testrepo',
            service: 'gitlab',
            slug: 'proboci/testrepo',
          });

          build.request.should.eql({
            branch: 'feature',
            branch_html_url: 'https://gitlab.com/proboci/testrepo/tree/feature',
            commit_url: 'https://gitlab.com/proboci/proboci/commit/6642b53392e3f2ef452249f4cee903aedabd0369',
            pull_request_id: 33015959,
            pull_request_description: '',
            pull_request_html_url: 'https://gitlab.com/proboci/testrepo/merge_requests/2',
            pull_request_name: 'change for feature branch',
            owner: 'proboci',
            pull_request: 1,
            repo: 'testrepo',
            repo_id: 33704441,
            service: 'gitlab',
            sha: '6642b53392e3f2ef452249f4cee903aedabd0369',
            slug: 'proboci/testrepo',
            type: 'merge_request',
            payload: payload,
          });

          done();
        });
      });
    });

    /*describe('push', function() {
      it('is handled', function(done) {
        let payload = require('./push_payload');

        // @todo: update headers
        let headers = {
          'X-GitLab-Event': 'push',
          'X-GitLab-Delivery': '8ec7bd00-df2b-11e4-9807-657b8ba6b6bd',
        };

        http(config.webhookPath).post({body: payload, headers: headers}, function(err, res, body) {
          // push events should return OK and do nothing else.
          body.should.eql({ok: true});
          done();
        });
      });
    });*/
  });

  /*describe('status update endpoint', function() {
    let glh;

    before('start another glh', function(done) {
      glh = new GitLabHandler(config);
      glh.start(function() {
        nock.enableNetConnect(glh.server.url.replace('http://', ''));
        done();
      });
    });

    let mocked;
    before('set up mocks', function() {
      // call the first cb arg w/ no arguments
      mocked = sinon.stub(glh, 'postStatusToGithlab').yields();
    });

    after('clear mocks', function() {
      mocked.reset();
    });

    it('accepts /update', function(done) {

      let update = {
        state: 'pending',
        description: 'Environment built!',
        context: 'ci/env',
        target_url: 'http://my_url.com',
      };

      let build = {
        projectId: '123',

        status: 'success',
        commit: {
          ref: 'd0fdf6c2d2b5e7402985f1e720aa27e40d018194',
        },
        project: {
          id: '1234',
          service: 'githlab',
          owner: 'proboci',
          repo: 'testrepo',
          slug: 'proboci/testrepo',
        },
      };

      http('/update', glh).post({body: {
        update: update,
        build: build,
      }}, function _(err, res, body) {
        should.not.exist(err);
        body.should.eql(update);

        done(err);
      });
    });

    it('accepts /builds/:bid/status/:context', function(done) {
      let update = {
        state: 'pending',
        description: 'Environment built!',
        context: 'ignored context',
        target_url: 'http://my_url.com',
      };

      let build = {
        projectId: '123',

        status: 'success',
        commit: {
          ref: 'd0fdf6c2d2b5e7402985f1e720aa27e40d018194',
        },
        project: {
          id: '1234',
          service: 'gitlab',
          owner: 'proboci',
          repo: 'testrepo',
          slug: 'proboci/testrepo',
        },
      };

      http('/builds/' + build.id + '/status/' + 'ci-env', glh).post({body: {
        update: update,
        build: build,
      }}, function _(err, res, body) {
        should.not.exist(err);
        body.should.eql({
          state: 'pending',
          description: 'Environment built!',
          // NOTE context gets inserted from URL
          context: 'ci-env',
          target_url: 'http://my_url.com',
        });

        done(err);
      });
    });
  });*/


  /*describe('probo.yaml file parsing', function() {
    let mocks = [];
    let updateSpy;
    let glh;

    let errorMessage = `Failed to parse .probo.yaml:bad indentation of a mapping entry at line 3, column 3:
      command: 'bad command'
      ^`;

    before('init mocks', function() {
      glh = new GithubHandler(config);

      // mock out Githlab API calls
      mocks.push(sinon.stub(glh, 'getGitlabApi').returns({
        repos: {
          getContent: function(opts, cb) {
            if (opts.path === '') {
              // listing of files
              cb(null, [{name: '.probo.yaml'}]);
            }
            else {
              // Getting content of a file - return a malformed YAML file.
              cb(null, {
                path: '.probo.yaml',
                content: new Buffer(`steps:
  - name: task
  command: 'bad command'`).toString('base64'),
              });
            }
          },
        },
      }));

      // mock out internal API calls
      mocks.push(
        sinon.stub(glh.api, 'findProjectByRepo').yields(null, {})
      );

      // ensure that buildStatusUpdateHandler is called
      updateSpy = sinon.stub(glh, 'buildStatusUpdateHandler').yields();
      mocks.push(updateSpy);
    });

    after('restore mocks', function() {
      mocks.forEach(function(mock) {
        mock.reset();
      });
    });

    it('throws an error for a bad yaml', function(done) {
      glh.fetchProboYamlConfigFromGitlab({}, null, function(err) {
        err.message.should.eql(errorMessage);
        done();
      });
    });

    it('sends status update for bad yaml', function(done) {
      glh.processRequest({sha: 'sha1'}, function() {
        let param1 = {
          state: 'failure',
          description: errorMessage,
          context: 'ProboCI/env',
        };
        let param2 = {
          commit: {ref: 'sha1'},
          project: {},
        };
        updateSpy.calledWith(param1, param2).should.equal(true);
        done();
      });
    });
  });*/
});

function initNock() {
  let project = {
    id: '1234',
    service: 'gitlab',
    owner: 'proboci',
    repo: 'testrepo',
    provider_id: 1234,
    slug: 'proboci/testrepo',
    service_auth: {
      token: 'testing'
    }
  };

  var buildId = 'build1';

  // nock out glh server - pass these requests through
  nock.enableNetConnect(glhServer.server.url.replace('http://', ''));

  // Nock out gitlab URLs.
  return nockout('requests.json', {
    not_required: ['status_update'],
    processor: function(nocks) {
      // nock out API URLs
      nocks.push(nock(config.api.url)
                 .get('/projects?service=gitlab&slug=proboci%2Ftestrepo&single=true')
                 .reply(200, project));
      nocks[nocks.length - 1].name = 'project_search';

      nocks.push(nock(config.api.url)
        .post('/startbuild')
        .reply(200, function(uri, requestBody) {
          // start build sets id and project id on build
          // and puts project inside build, returning build
          let body = JSON.parse(requestBody);
          body.build.id = buildId;
          body.build.projectId = body.project.id;
          body.build.project = body.project;
          delete body.project;
          return body.build;
        }, {
          'content-type': 'application/json',
        }));
      nocks[nocks.length - 1].name = 'startbuild';

      nocks.push(nock(config.api.url)
        .persist()
        .filteringPath(/status\/[^/]*/g, 'status/context')
        .post('/builds/' + buildId + '/status/context')
        .reply(200, {
          state: 'success',
          description: 'Tests passed Thu Apr 30 2015 17:41:43 GMT-0400 (EDT)',
          context: 'ci/tests',
        }));
      nocks[nocks.length - 1].name = 'status_update';
    },
  });
}
