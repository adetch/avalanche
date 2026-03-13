FROM opencfd/openfoam-dev:2312

# faSavageHutterFoam and all avalanche utilities (slopeMesh, makeFaMesh,
# releaseAreaMapping) are already compiled in the base image.
# No additional compilation or package installation is needed.

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /case

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
