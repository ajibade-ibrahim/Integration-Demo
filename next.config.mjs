/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The sync engine and OAuth handlers are server-only and use node crypto.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
