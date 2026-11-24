import { connect, hub, peers } from "./peers.mjs";
import { sessions } from "./sessions.mjs";
import { setup } from "./setup.mjs";
import { signIn } from "./sign-in.mjs";

/** Every mockup screen, in the order of a first day. */
export const screens = [setup, signIn, peers, connect, hub, sessions];
