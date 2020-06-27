# Probo GitLab Handler
The [GitLab integration](https://docs.probo.ci/integrations/gitlab/) and [GitLab Server integration](https://docs.probo.ci/integrations/gitlab-server/) service for [Probo.CI](https://probo.ci/).

## Node Version
Several of Probo's microservices are currently on different Node versions as we update to newer Node versions, so the Node Verson Manager, [nvm](https://github.com/nvm-sh/nvm), is installed to switch between different versions of Node prior to running `npm install`.

**Current Node Version:** Node 12.x

Run the following commands in the `probo-gitlab-handler` directory to update the node_modules for the `probo-gitlab-handler`.

    nvm use 12
    npm install

## Starting the Probo Open Source App

    ./bin/probo-gitlab-handler -c config.yaml

See [defaults.yaml](https://github.com/ProboCI/probo-gitlab/blob/master/defaults.yaml) for required configuration.

## Restarting the Probo GitLab Handler Service
The `probo-gitlab-handler` service has no restrictions on restarting, although you may also want to restart the ngrok service for local development.

    systemctl restart probo-gitlab-handler
