FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force && mkdir -p /data && chown node:node /data && chmod 700 /data
COPY bin/gemini-gateway bin/gemini-gateway
COPY src/gateway-server.mjs src/native-provider.mjs src/tool-protocol.mjs src/prompt-tool-schema.mjs src/openai-contract.mjs src/openai-usage.mjs src/responses-tool-namespaces.mjs src/image-input.mjs src/image-url.mjs src/
COPY src/gateway/ src/gateway/
COPY src/admin-v2/index.html src/admin-v2/app.js src/admin-v2/styles.css src/admin-v2/
COPY native-wire/consumer-tool-codec.mjs native-wire/protobuf.mjs native-wire/robin-current.mjs native-wire/oauth-loopback.mjs native-wire/
USER node
ENV NODE_ENV=production GATEWAY_DATA_DIR=/data GATEWAY_HOST=0.0.0.0 GATEWAY_ALLOW_REMOTE=1 GATEWAY_CALLBACK_HOST=0.0.0.0
EXPOSE 18989 18765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:18989/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/gateway-server.mjs"]
