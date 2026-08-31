FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    ca-certificates \
    sudo \
    curl \
    && rm -rf /var/lib/apt/lists/*

ARG VSCODIUM_COMMIT=4c0b0c6cc561d2d3636d1ec250935431876ce4dc
ARG VSCODIUM_SERVER_URL=https://github.com/VSCodium/vscodium/releases/download/1.126.04524/vscodium-reh-linux-x64-1.126.04524.tar.gz

RUN mkdir -p "/etc/skel/.vscodium-server/bin/${VSCODIUM_COMMIT}" \
    && curl --fail --location --retry 3 --output /tmp/vscodium-server.tar.gz "${VSCODIUM_SERVER_URL}" \
    && tar -xzf /tmp/vscodium-server.tar.gz --strip-components=1 -C "/etc/skel/.vscodium-server/bin/${VSCODIUM_COMMIT}" \
    && test -s "/etc/skel/.vscodium-server/bin/${VSCODIUM_COMMIT}/bin/codium-server" \
    && rm -f /tmp/vscodium-server.tar.gz

EXPOSE 2222
VOLUME /config

COPY start-sshd.sh /usr/local/bin/start-sshd.sh
RUN chmod +x /usr/local/bin/start-sshd.sh

RUN rm -f /usr/bin/flock

CMD ["/usr/local/bin/start-sshd.sh"]
