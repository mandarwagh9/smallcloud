export interface Mailer {
  send(to: string, subject: string, text: string, html: string): Promise<void>;
}

/** Resend (https://resend.com) over plain fetch. */
export function resendMailer(apiKey: string, from: string): Mailer {
  return {
    async send(to, subject, text, html) {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text, html }),
      });
      if (!res.ok) throw new Error(`resend ${res.status}: ${await res.text()}`);
    },
  };
}

/** Dev/test mailer: prints to the log and remembers the last message. */
export function consoleMailer(log: (s: string) => void = (s) => console.log(s)): Mailer & { last: { to: string; text: string } | null } {
  const m = {
    last: null as { to: string; text: string } | null,
    async send(to: string, subject: string, text: string) {
      m.last = { to, text };
      log(`\n[mail] to ${to}: ${subject}\n${text}\n`);
    },
  };
  return m;
}

export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer {
  if (env.RESEND_API_KEY) return resendMailer(env.RESEND_API_KEY, env.EMAIL_FROM || 'smallcloud <onboarding@resend.dev>');
  return consoleMailer();
}
