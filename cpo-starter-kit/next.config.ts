import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Send the <title> in the first HTML for every visitor. By default Next streams
  // metadata after the page body for browsers, so a slow page can paint (and be
  // read by a screen reader or an accessibility check) with no title yet.
  htmlLimitedBots: /.*/,
};
export default nextConfig;
