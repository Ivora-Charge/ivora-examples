/**
 * What today's sign-in answers mean for the page. The server gives a sentence only (no
 * code, no wait): both rate limits, this server's and the email service's, end as the
 * same one. A unit test holds these to the sentences the server sends.
 */
export const LIMITED_MESSAGE = "Too many sign-in attempts. Try again later.";
export const NOT_ADMIN_MESSAGE = "This account is not an admin.";

export type SignInProblem = "limited" | "not_admin" | "other";

export function signInProblem(message: string | undefined): SignInProblem {
  if (message === LIMITED_MESSAGE) return "limited";
  if (message === NOT_ADMIN_MESSAGE) return "not_admin";
  return "other";
}

/** The statement that adds the first admin, for the address that asked for a code. */
export function firstAdminSql(email: string): string {
  return `insert into public.emsp_admins (user_id, role)
select id, 'admin' from auth.users
where email = '${email.replaceAll("'", "''")}';`;
}
