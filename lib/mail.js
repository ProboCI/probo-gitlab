"use strict";

const { readFileSync } = require('fs');
const mjml2html = require('mjml');
const nodemailer = require("nodemailer");

class Mail {

  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.enabled = (config.mail.smtpServer) ? true : false;
  }

  async send(vars) {
    if (this.enabled === true) {
      const HTMLEmail = this.parseTemplate('standard-error-html', vars, true);
      const textEmail = this.parseTemplate('standard-error-text', vars, false);

      // create reusable transporter object using the default SMTP transport
      let transporter = nodemailer.createTransport({
        host: this.config.mail.smtpServer,
        port: this.config.mail.smtpPort,
        secure: this.config.mail.secure,
        auth: {
          user: this.config.mail.smtpUser, // generated ethereal user
          pass: this.config.mail.smtpPass, // generated ethereal password
        },
      });

      // send mail with defined transport object
      let info = await transporter.sendMail({
        from: this.config.mail.from,
        to: this.config.mail.to,
        subject: vars.subject,
        text: textEmail,
        html: HTMLEmail,
      });
      
      this.logger.info({info}, 'Sending Email Information');
    }
  }

  parseTemplate(template, vars, isHTML) {
    let html = null;
    // let data = null;

    // Load template.
    const tpl = readFileSync(`./email-templates/${template}.mjml`, 'utf8');

    // Interpolate variables.
    for (const prop in vars) {
      tpl = tpl.replaceAll('{{ ' + prop + ' }}', vars[prop]);
      // data = data.replaceAll('{{ filename }}', vars.stack.file);
      // data = data.replaceAll('{{ line_number }}', vars.stack.line);
      // data = data.replaceAll('{{ email_type }}', vars.email_type);
      // data = data.replaceAll('{{ email_system }}', vars.email_system);
    }

    // Render.
    if (isHTML === true) {
      html = mjml2html(tpl);
      html = html.html;
    } else {
      html = tpl;
    }
    return html;
  }
}

module.exports = Mail;
