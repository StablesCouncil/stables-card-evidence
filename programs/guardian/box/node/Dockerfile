# The guardian's own Minima node: Minima's official release, refused unless its sha256 is the pinned one (the same
# pin as The Bay's built-in node, fetch-minima-core.mjs).
FROM eclipse-temurin:17-jre
ADD --checksum=sha256:b22182ec5c9389fe52c7cababa79e7e7966726b8996d6a31593f8ae69232af20 \
    https://github.com/minima-global/Minima/releases/download/1.0.49/minima.jar /opt/minima/minima.jar
COPY start.sh /opt/minima/start.sh
RUN chmod 755 /opt/minima/start.sh
CMD ["/opt/minima/start.sh"]
