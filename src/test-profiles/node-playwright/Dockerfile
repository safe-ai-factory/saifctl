FROM mcr.microsoft.com/playwright:v1.58.2-jammy

# We run tests via playwright. 
# Pre-install typescript/playwright so the container can just run npx playwright test.
# Actually mcr.microsoft.com/playwright comes with playwright already, but we need
# to make sure typescript and the test runner is available globally or we initialize it.

# Set up the workspace
WORKDIR /workspace

# Install global typescript if needed
RUN npm install -g typescript tsx @playwright/test playwright

# Default command expects the Orchestrator to bind-mount /usr/local/bin/test.sh
CMD ["/usr/local/bin/test.sh"]
