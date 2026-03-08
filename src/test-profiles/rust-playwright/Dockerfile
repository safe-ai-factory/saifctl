# Base on the official Playwright image (Node + browsers pre-installed on Debian).
# playwright-rs bundles the Playwright Node.js driver and shells out to it at runtime,
# so the browsers must be present in the image.
FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# Install Rust toolchain into the Playwright base image.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.93.0 --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

RUN cargo install cargo-nextest --locked

WORKDIR /workspace
CMD ["/usr/local/bin/test.sh"]
