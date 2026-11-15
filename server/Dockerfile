FROM node:22-slim

# Keep the runtime environment production-oriented. Secrets are supplied at
# runtime and must never be baked into the image.
ENV NODE_ENV=production

WORKDIR /app

# Install only production dependencies from the committed lockfile.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy only the files required to run the backend.
COPY --chown=node:node index.js ./
COPY --chown=node:node modules ./modules

# The official Node image provides the non-root node user.
USER node

# The application reads PORT from the environment and defaults to 3000.
EXPOSE 3000

# Use the inexpensive /health endpoint, never the AI-dependent intake health
# endpoint. This fails if the server is unreachable or returns a non-2xx status.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const port = parseInt(process.env.PORT, 10) || 3000; fetch('http://127.0.0.1:' + port + '/health').then((res) => process.exit(res.ok ? 0 : 1)).catch(() => process.exit(1));"

# Preserve the existing application startup command.
CMD ["npm", "start"]
