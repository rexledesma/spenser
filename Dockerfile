FROM denoland/deno:latest

# Create working directory
WORKDIR /app

# Copy source
COPY . .

# Install dependencies (use just `deno install` if deno.json has imports)
RUN deno install --entrypoint main.ts

# Run the app
CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read=/data,static", "--allow-write=/data", "main.ts"]
