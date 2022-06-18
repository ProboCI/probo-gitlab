'use strict';

const { Kafka } = require('kafkajs')

class ProboEmailer {

  constructor(config, logger) {
    this.kafka = new Kafka({
      clientId: 'probo-email',
      brokers: ['localhost:9092']
    });
    this.kafkaProducer = kafka.producer();
    this.kafkaTopic = 'email_events';
    this.logger = logger;
    this.config = config;
  }

  // const email = {
  //   template: "generic",
  //   subject: "This is a test email",
  //   email_message: message,
  //   email_system: "Token Generator",
  //   filename: "/path/to/fuckstick.js",
  //   line_number: "4387",
  //   error_message: "This is sample error text."
  // };

  async sendEmail(data) {
    const payload = JSON.stringify(data);
    await this.kafkaProducer.connect();
    try {
      await this.kafkaProducer.send({
          topic: this.kafkaTopic,
          messages: [
            { value: payload },
          ],
        });
    } catch (error) {
      this.logger.error({error}, 'Error trying to contact probo-email');
    }
    await this.kafkaProducer.disconnect();
  }
}

module.exports = ProboEmailer;
