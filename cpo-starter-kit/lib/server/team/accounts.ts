import "server-only";
import { config } from "../env";
import { signInEmail, type Mailer } from "../mail";
import { serviceClient, sessionClient } from "../supabase";
import { TeamError, type Accounts } from "./types";

/**
 * Staff logins in Supabase Auth. There is no public sign-up: logins are created only
 * here, by the setup screen (first owner) and by accepting an invite, with the email
 * marked confirmed because the person proved it (setup secret or the emailed link).
 */
export function createSupabaseAccounts(
  mailer: Mailer | null,
  operatorName: () => string,
): Accounts {
  return {
    async currentUser() {
      // getUser() asks Supabase Auth, so a revoked or expired session fails here.
      const { data, error } = await (await sessionClient()).auth.getUser();
      if (error || !data.user?.email) return null;
      return { id: data.user.id, email: data.user.email.toLowerCase() };
    },
    async createUser(email, password) {
      const { data, error } = await serviceClient().auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (error?.code === "email_exists") return "exists";
      if (error?.code === "weak_password")
        throw new TeamError(
          "weak_password",
          "Choose a stronger password: longer, mixing words, numbers and symbols.",
        );
      if (error || !data.user)
        throw new Error(
          `Supabase Auth could not create the login (${error?.code ?? "unknown"}).`,
        );
      return data.user.id;
    },
    async deleteUser(userId) {
      const { error } = await serviceClient().auth.admin.deleteUser(userId);
      if (error)
        throw new Error(
          `Supabase Auth could not delete the login (${error.code ?? "unknown"}).`,
        );
    },
    async signInWithPassword(email, password) {
      const { data, error } = await (
        await sessionClient()
      ).auth.signInWithPassword({ email, password });
      if (error || !data.user) return null;
      return data.user.id;
    },
    async sendSignInLink(email) {
      if (mailer) {
        // Our own email, so the link works in any browser. Callers have already
        // checked that this email belongs to a staff member.
        const { data, error } = await serviceClient().auth.admin.generateLink({
          type: "magiclink",
          email,
        });
        const token = data?.properties?.hashed_token;
        if (error || !token)
          throw new Error(
            `Supabase Auth could not create the link (${error?.code ?? "unknown"}).`,
          );
        // The token rides in the fragment, which browsers never send to servers or logs.
        await mailer.send(
          signInEmail({
            to: email,
            operatorName: operatorName(),
            link: `${config.appUrl}/auth/confirm#${token}`,
          }),
          `cpo-sign-in-${token.slice(0, 32)}`,
        );
        return;
      }
      // Supabase's own email. The link must be opened in this same browser (PKCE).
      const { error } = await (
        await sessionClient()
      ).auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${config.appUrl}/auth/callback`,
        },
      });
      if (error)
        throw new Error(
          `Supabase Auth could not send the link (${error.code ?? "unknown"}).`,
        );
    },
    async verifySignInLink(tokenHash) {
      const { error } = await (
        await sessionClient()
      ).auth.verifyOtp({ token_hash: tokenHash, type: "email" });
      return !error;
    },
    async exchangeCode(code) {
      const { error } = await (
        await sessionClient()
      ).auth.exchangeCodeForSession(code);
      return !error;
    },
    async signOut() {
      await (await sessionClient()).auth.signOut();
    },
  };
}
