# Update Center agent — Docker launcher.
# The container only installs and supervises the agent: it enters the HOST's namespaces
# (needs --privileged --pid=host) and runs the agent there with the host's python3,
# so updates, reboots and the terminal act on the real host, not the container.
FROM alpine:3.22
LABEL org.opencontainers.image.title="Update Center agent" \
      org.opencontainers.image.description="Runs the Update Center agent on the Docker host (privileged launcher)" \
      org.opencontainers.image.source="https://github.com/thekingziga/update-center" \
      org.opencontainers.image.licenses="MIT"
RUN apk add --no-cache util-linux-misc
COPY uc-agent.py /uc-agent.py
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod 755 /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
