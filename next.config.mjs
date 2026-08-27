/** @type {import('next').NextConfig} */
const nextConfig = {
  // firebase-admin is a CJS/native-heavy package: keep it out of the bundler and
  // let Node require it straight from node_modules at runtime.
  serverExternalPackages: ['firebase-admin'],
};

export default nextConfig;
