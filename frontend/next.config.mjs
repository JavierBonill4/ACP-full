/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @acp/economics is a workspace package shipped as plain .mjs. Next needs to
  // be told to transpile it rather than treat it as a prebuilt dependency.
  transpilePackages: ["@acp/economics"],
};

export default nextConfig;
