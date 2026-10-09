# syntax=docker/dockerfile:1
# Both multi-platform indexes are pinned. Update these intentionally for JVM/security fixes.
ARG PYTHON_IMAGE=python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26
ARG JAVA_IMAGE=eclipse-temurin:25.0.4.1_1-jre-noble@sha256:08c5df59d84343e310567081253611b244bb7a1329930eb09d6923f6fa66dffa
ARG PACK_ID=vanilla-plus

# A clean checkout can build the image without Python/Java on the host.
FROM --platform=$BUILDPLATFORM ${PYTHON_IMAGE} AS pack-build
ARG PACK_ID
WORKDIR /src
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt ./
COPY LICENSE THIRD_PARTY.md ./
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY tools/build.py tools/
COPY packs/ packs/
COPY templates/ templates/
COPY docs/ docs/
RUN --mount=type=cache,target=/src/.cache/downloads,sharing=locked python3 tools/build.py build --pack "$PACK_ID" --side server

FROM ${JAVA_IMAGE} AS runtime-base
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 git git-lfs \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 minecraft \
    && useradd --uid 10001 --gid minecraft --create-home --shell /usr/sbin/nologin minecraft \
    && install -d -m 0755 -o minecraft -g minecraft /data /backups /opt/mvs/server
COPY --chown=root:root docker/runtime.py /opt/mvs/runtime.py
ARG MVS_VERSION=development
ARG VCS_REF=unknown
ARG IMAGE_SOURCE=https://cnb.cool/Mintimate/tool-forge/minecraft-vanilla-stack
LABEL org.opencontainers.image.title="Minecraft Vanilla Stack" \
      org.opencontainers.image.description="Pinned Fabric vanilla survival server" \
      org.opencontainers.image.source="${IMAGE_SOURCE}" \
      org.opencontainers.image.version="${MVS_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    MC_MIN_MEMORY=1G MC_MAX_MEMORY=4G \
    MVS_SERVER_DIR=/opt/mvs/server MVS_DATA_DIR=/data
WORKDIR /data
VOLUME ["/data", "/backups"]
EXPOSE 25565/tcp
EXPOSE 24454/udp
USER minecraft:minecraft
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m --retries=5 \
    CMD ["python3", "/opt/mvs/runtime.py", "healthcheck"]
ENTRYPOINT ["python3", "/opt/mvs/runtime.py"]
CMD ["run"]

# CI already produced/verified the ZIP. Use its identical directory without redownloading.
FROM runtime-base AS runtime-prebuilt
ARG PACK_ID
COPY --chown=root:root build/${PACK_ID}/server/ /opt/mvs/server/

# Default target for docker compose build / a source checkout.
FROM runtime-base AS runtime
ARG PACK_ID
COPY --from=pack-build --chown=root:root /src/build/${PACK_ID}/server/ /opt/mvs/server/
