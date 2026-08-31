ARG SIGNALK_IMAGE=cr.signalk.io/signalk/signalk-server@sha256:e319e79a7e71ea0157f0ca3a112e2a4c8c1b57902998793001e0d89d144f7781

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS plugin-build
WORKDIR /source
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build \
    && mkdir /package \
    && npm pack --ignore-scripts --pack-destination /package

FROM ${SIGNALK_IMAGE}
USER root
COPY --from=plugin-build /package/*.tgz /opt/signalk-wakelogger.tgz
COPY test/docker/signalk-entrypoint.sh /opt/signalk-wakelogger-entrypoint.sh
RUN chmod 0755 /opt/signalk-wakelogger-entrypoint.sh \
    && chown node:node /opt/signalk-wakelogger.tgz
USER node
ENTRYPOINT ["/opt/signalk-wakelogger-entrypoint.sh"]
CMD ["--sample-n2k-data"]
