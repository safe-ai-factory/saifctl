FROM rust:1.93-alpine
RUN cargo install cargo-nextest --locked
WORKDIR /workspace
CMD ["/usr/local/bin/test.sh"]
