import { account } from "./account.mjs";
import { card } from "./card.mjs";
import { charging } from "./charging.mjs";
import { receipt } from "./receipt.mjs";
import { session } from "./session.mjs";
import { start } from "./start.mjs";
import { status } from "./status.mjs";

/** Every mockup screen, in the order of a guest's charge. */
export const screens = [
  start,
  card,
  status,
  session,
  receipt,
  charging,
  account,
];
