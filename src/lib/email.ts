import { env } from "@/env";

/** Email adapter. Development default logs to the console; SMTP is a placeholder seam. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailAdapter {
  send(message: EmailMessage): Promise<void>;
}

class ConsoleEmailAdapter implements EmailAdapter {
  async send(message: EmailMessage) {
    console.log(
      `\n📧 [email:console] to=${message.to}\n   subject: ${message.subject}\n   ${message.text.replace(/\n/g, "\n   ")}\n`,
    );
  }
}

class SmtpEmailAdapter implements EmailAdapter {
  async send(): Promise<void> {
    // TODO(prod): wire nodemailer or a transactional provider (SES / Resend / Postmark).
    throw new Error("SMTP email adapter not implemented in v0.1; set EMAIL_PROVIDER=console");
  }
}

export function getEmailAdapter(): EmailAdapter {
  return env().EMAIL_PROVIDER === "smtp" ? new SmtpEmailAdapter() : new ConsoleEmailAdapter();
}
