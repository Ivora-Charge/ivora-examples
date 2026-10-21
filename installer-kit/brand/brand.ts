/** Lugline brand copy. Renaming the product is a one-line change to `name`. */
export const brand = {
  name: "Lugline",
  tagline: "Connect, test and hand over an OCPP charger",
  lead: "Connect a site's OCPP charger, prove it works, and hand over QR stickers and a commissioning report.",
  support:
    "Stuck? Check the URL, the password and the network, then reboot the charger.",
  connectHint: "Plug in the charger. Then tap Test.",
};

/** Landing page copy. Edit freely; nothing else reads it. */
export const landing = {
  headline: "On site. Plug in. Prove it.",
  who: "For installers, electricians and hardware sellers who hand a working OCPP charger to a site owner.",
  flows: [
    {
      title: "Connect",
      text: "Add the charger and copy the URL, ID and password into it. Scan the QR codes from your phone.",
    },
    {
      title: "Test",
      text: "Wait for the online check, then start and stop a short session and read the settings back.",
    },
    {
      title: "Hand over",
      text: "Print a QR sticker per connector and a one-page commissioning report.",
    },
  ],
};
