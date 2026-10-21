// Copies the brand tokens from the server (the copy you edit) to the driver app.
// A unit test fails CI if the two copies differ.
import { copyFile } from "node:fs/promises";

const from = new URL("../brand/tokens.json", import.meta.url);
const to = new URL("../../app/brand/tokens.json", import.meta.url);
await copyFile(from, to);
console.log("Copied brand/tokens.json to ../app/brand/tokens.json");
