'use strict';

const fs = require('fs');
const nock = require('nock');
const Promise = require('bluebird');
const request = require('request');
const should = require('should');
const sinon = require('sinon');
const util = require('util');
const yaml = require('js-yaml');

const nockout = require('./__nockout');

const GitLabHandler = require('../lib/GitLabHandler');

let config = {
  webhookPath: '/glh',
  webhookSecret: 'secret',
  port: 0,
  api: {
    url: 'http://localhost:3000',
    token: 'token',
  },
  gitLabToken: '1234',
  logLevel: Number.POSITIVE_INFINITY,
};

let glhServer = new GitLabHandler(config);

function http(path, glh) {
  glh = glh || glhServer;
  let options = {
    url: util.format('%s%s', glh.server.url, path),
    json: true,
  };

  return request.defaults(options);
}

describe('GitLabHandler', () => {
  describe('webhooks', () => {
    before('start GitLabHandler server', () => {
      glhServer.start();
    });

    after('stop GitLabHandler server', () => {
      glhServer.close();
    });

    describe('pull', () => {
      let nocker;
      let handlerMocked;

      before(() => {
        // Mocks the download of the probo.yaml config file.
        handlerMocked = sinon.stub(glhServer.gitlab, 'fetchProboYamlConfig')
          .callsFake((project, sha, cb) => {
            let settings = yaml.safeLoad(fs.readFileSync('test/files/probo.yaml', 'utf8'));

            cb(null, settings);
          });
      });

      beforeEach('nock out network calls', () => {
        nocker = initNock();
      });

      after(() => {
        handlerMocked.restore();
      });

      afterEach('reset network mocks', () => {
        nocker.cleanup();
      });

      it('is routed', done => {

        let payload = require('./fixtures/pull_payload');
        let headers = {
          'X-GitLab-Token': 'secret',
          'X-GitLab-Event': 'Merge Request Hook',
        };

        http(config.webhookPath)
          .post({body: payload, headers: headers}, (err, res, body) => {
            // handles push by returning OK and doing nothing else
            should.not.exist(err);
            body.should.eql({ok: true});

            // TODO: WAT? why isn't this a set of async callbacks so we actually know when it's done?!
            // pause for a little before finishing to allow push processing to run
            // and hit all the GL nocked endpoints
            setTimeout(done, 200);
          });
      });


      it('is handled', done => {
        let payload = require('./fixtures/pull_payload');

        // fire off handler event
        let event = {
          event: 'merge_request',
          id: 'a60aa880-df33-11e4-857c-eca3ec12497c',
          url: '/glh',
          payload: payload,
        };
        glhServer.mergeRequestHandler(event, (err, build) => {
          should.not.exist(err);
          build.should.be.a.object;
          build.id.should.eql('build1');
          build.projectId.should.eql('1234');
          build.commit.should.be.a.object;
          build.commit.ref.should.eql('07fca8f08ae1ad8a77c50beab4bf6302c705e21e');
          build.pullRequest.should.be.a.object;
          build.pullRequest.number.should.eql('1');
          build.branch.should.be.a.object;
          build.branch.name.should.eql('master');

          build.config.should.eql({
            steps: [{
              'name': 'Probo site setup',
              'plugin': 'LAMPApp',
            }],
          });

          build.project.should.eql({
            id: '1234',
            provider_id: 1234,
            owner: 'proboci',
            repo: 'testrepo',
            service: 'gitlab',
            service_auth: {
              token: "testing"
            },
            slug: 'proboci/testrepo',
          });

          done();
        });
      });
    });

    describe('push', () => {
      it('is handled', done => {
        let payload = require('./fixtures/push_payload');

        let headers = {
          'X-GitLab-Event': 'push',
          'X-GitLab-Delivery': '8ec7bd00-df2b-11e4-9807-657b8ba6b6bd',
        };

        http(config.webhookPath).post({body: payload, headers: headers}, (err, res, body) => {
          // push events should return OK and do nothing else.
          body.should.eql({ok: true});
          done();
        });
      });
    });
  });

  describe('status update endpoint', () => {

    let glh;
    let gitlabMocked;
    let handlerMocked;

    let build = {
      projectId: '123',

      status: 'success',
      commit: {
        ref: 'd0fdf6c2d2b5e7402985f1e720aa27e40d018194',
      },
      project: {
        provider_id: '1234',
        service: 'githlab',
        owner: 'proboci',
        repo: 'testrepo',
        slug: 'proboci/testrepo',
      },
    };

    before('start another glh', done => {
      glh = new GitLabHandler(config);
      glh.start(() => {
        nock.enableNetConnect(glh.server.url.replace('http://', ''));
        done();
      });
    });

    before('set up mocks', () => {
      // Mocks the request to post a status.
      handlerMocked = sinon.stub(glh.gitlab, 'postStatus')
        .callsFake((project, sha, statusInfo, done) => {
          project.should.eql(build.project);
          sha.should.equal(build.commit.ref);

          done(null, statusInfo);
        });
    });

    after('clear mocks', () => {
      handlerMocked.restore();
      glh.close();
    });

    it('accepts /update', done => {

      let update = {
        state: 'pending',
        description: 'Environment built!',
        context: 'ci/env',
        target_url: 'http://my_url.com',
      };

      http('/update', glh).post({body: {
        update: update,
        build: build,
      }}, (err, res, body) => {
        if (err) return done(err);

        should.not.exist(err);
        body.should.eql(update);

        done();
      });
    });

    it('accepts /builds/:bid/status/:context', done => {
      let update = {
        state: 'pending',
        description: 'Environment built!',
        context: 'ignored context',
        target_url: 'http://my_url.com',
      };

      http(`/builds/${build.id}/status/ci-env`, glh)
        .post({body: {
          update: update,
          build: build,
        }}, (err, res, body) => {
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
  });


  describe('probo.yaml file parsing', () => {
    let mocks = [];
    let updateSpy;
    let glh;

    let errorMessageEmpty = 'Failed to parse .probo.yml: The first argument must be one of type string, Buffer, ArrayBuffer, Array, or Array-like Object. Received type undefined';
    let errorMessageBad = `Failed to parse .probo.yml: bad indentation of a mapping entry at line 3, column 5:
        command: 'bad command'
        ^`;

    before('init mocks', () => {
      glh = new GitLabHandler(config);

      let gitLabApi = sinon.stub(glh.gitlab, 'getApi').returns({
        RepositoryFiles: {
          show: (projectId, filePath, ref) => {
            if (ref == 'sha1') {
              return Promise.resolve({
                    file_path: '.probo.yml',
                    content: new Buffer.from(`steps:
    - name: task
    command: 'bad command'`).toString('base64')
              });
            }
            else {
              return Promise.resolve({file_path: '.probo.yml'});
            }
          },
        }
      });
      mocks.push(gitLabApi);

      // Mocks out internal API calls
      mocks.push(
        sinon.stub(glh.api, 'findProjectByRepo').yields(null, {})
      );

      // Mocks buildStatusUpdateHandler.
      updateSpy = sinon.stub(glh, 'buildStatusUpdateHandler').yields();
      mocks.push(updateSpy);
    });

    after('restore mocks', () => {
      mocks.forEach(mock => {
        mock.restore();
      });

      glh.close();
    });

    it('throws an error for a bad yaml', done => {
      glh.gitlab.fetchProboYamlConfig({service_auth: {token: 'testing'}}, null, (err, config) => {
        try {
          err.message.should.eql(errorMessageEmpty);
          done();
        } catch (e) {
          done(e);
        };
      });
    });

    it('sends status update for bad yaml', done => {
      glh.processWebhookEvent({sha: 'sha1', type: 'gitlab', id: 'bad'}, () => {
        let param1 = {
          state: 'error',
          description: errorMessageBad,
          context: 'ProboCI/env',
        };
        let param2 = {
          commit: {ref: 'sha1'},
          project: {},
        };
        try {
          updateSpy.calledWith(param1, param2).should.equal(true);
          done();
        } catch (e) {
          done(e);
        }
      });
    });
  });
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

  let buildId = 'build1';

  // Enables requests to GitLab Handler through.
  nock.enableNetConnect(glhServer.server.url.replace('http://', ''));

  // Nocks out URLs related to the container API.
  return nockout({
    not_required: ['status_update'],
    processor: nocks => {
      // nock out API URLs
      nocks.push(nock(config.api.url)
                 .get('/projects?service=gitlab&slug=proboci%2Ftestrepo&single=true')
                 .reply(200, project));
      nocks[nocks.length - 1].name = 'project_search';

      nocks.push(nock(config.api.url)
        .defaultReplyHeaders({
          'Content-Type': 'application/json',
        })
        .post('/startbuild')
        .reply(200, (uri, requestBody) => {
          // start build sets id and project id on build
          // and puts project inside build, returning build
          let body = requestBody;
          body.build.id = buildId;
          body.build.projectId = body.project.id;
          body.build.project = body.project;
          delete body.project;

          return body.build;
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
