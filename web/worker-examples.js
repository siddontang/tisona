// Keep the public SDK APIs and separate routing groups for each runtime.
const inputSchema = { type: 'object', additionalProperties: false, required: ['name'], properties: {
  name: { type: 'string', title: 'Name', description: 'The name to greet.', minLength: 1, maxLength: 100 }
} };
const javascript = `import { Resonate } from '@resonatehq/sdk/async';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error('Set ' + name);
  return value;
};

async function greeting(_info, name) {
  return 'Hello, ' + name + '!';
}

async function hello_javascript(ctx, input) {
  return await ctx.run(greeting, input.name);
}

const worker = new Resonate({
  url: required('RESONATE_URL'),
  token: required('RESONATE_TOKEN'),
  pid: required('WORKER_ID'),
  group: 'hello-javascript-v1'
});
worker.register('hello_javascript', hello_javascript, { version: 1 });
console.log('Worker listening. Publish its manifest in step 3.');

async function stop() { await worker.stop(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);`;
const typescript = javascript
  .replace("import { Resonate }", "import { Resonate, type Context, type Info }")
  .replace('required = name =>', 'required = (name: string): string =>')
  .replace('greeting(_info, name)', 'greeting(_info: Info, name: string): Promise<string>')
  .replaceAll('hello_javascript', 'hello_typescript').replaceAll('hello-javascript', 'hello-typescript')
  .replace('hello_typescript(ctx, input)', 'hello_typescript(ctx: Context, input: { name: string })');

export const workerExamples = [
  { id: 'typescript', label: 'TypeScript', version: 'SDK 0.11.5 · Node.js', file: 'worker.ts',
    docs: 'https://docs.resonatehq.io/develop/typescript',
    install: 'npm init -y\nnpm install @resonatehq/sdk@0.11.5\nnpm install --save-dev tsx typescript @types/node', run: 'npx tsx worker.ts', code: typescript },
  { id: 'javascript', label: 'JavaScript', version: 'SDK 0.11.5 · Node.js', file: 'worker.mjs',
    docs: 'https://docs.resonatehq.io/develop/typescript',
    install: 'npm init -y\nnpm install @resonatehq/sdk@0.11.5', run: 'node worker.mjs', code: javascript },
  { id: 'python', label: 'Python', version: 'SDK 0.8.1 · Python 3.12+', file: 'worker.py',
    docs: 'https://docs.resonatehq.io/develop/python',
    install: 'python3 -m venv .venv\n. .venv/bin/activate\npython -m pip install resonate-sdk==0.8.1', run: 'python worker.py',
    code: `import asyncio
import os

from resonate.context import Context
from resonate.resonate import Resonate


async def greeting(ctx: Context, name: str) -> str:
    return f"Hello, {name}!"


async def hello_python(ctx: Context, input: dict) -> str:
    return await ctx.run(greeting, input["name"])


async def main() -> None:
    worker = Resonate(
        url=os.environ["RESONATE_URL"],
        token=os.environ["RESONATE_TOKEN"],
        pid=os.environ["WORKER_ID"],
        group="hello-python-v1",
    )
    worker.register(hello_python, name="hello_python", version=1)
    print("Worker listening. Publish its manifest in step 3.")
    try:
        await asyncio.Event().wait()
    finally:
        await worker.stop()


if __name__ == "__main__":
    asyncio.run(main())` },
  { id: 'go', label: 'Go', version: 'Go SDK · Early release', file: 'main.go',
    docs: 'https://docs.resonatehq.io/develop/go',
    install: 'go mod init example.com/tisona-worker\ngo get github.com/resonatehq/resonate-sdk-go@v0.0.0-20260824201422-013db8164143', run: 'go run .',
    note: 'This sample pins SDK commit 013db8164143. Commit go.mod and go.sum to retain the exact dependency.',
    code: `package main

import (
    "context"
    "fmt"
    "log"
    "os"
    "os/signal"
    "syscall"

    resonate "github.com/resonatehq/resonate-sdk-go"
    "github.com/resonatehq/resonate-sdk-go/httpnet"
)

type Input struct { Name string \x60json:"name"\x60 }

func required(name string) string {
    value := os.Getenv(name)
    if value == "" { log.Fatalf("Set %s", name) }
    return value
}

func greeting(_ resonate.Info, name string) (string, error) {
    return fmt.Sprintf("Hello, %s!", name), nil
}

func helloGo(ctx *resonate.Context, input Input) (string, error) {
    future, err := ctx.Run(greeting, input.Name)
    if err != nil { return "", err }
    var result string
    err = future.Await(&result)
    return result, err
}

func main() {
    token := required("RESONATE_TOKEN")
    network := httpnet.NewHTTP(required("RESONATE_URL"), httpnet.HTTPOptions{
        PID: required("WORKER_ID"), Group: "hello-go-v1", Auth: token,
    })
    worker, err := resonate.New(resonate.Config{Network: network, Token: token})
    if err != nil { log.Fatal(err) }
    defer func() { _ = worker.Stop() }()
    if _, err := resonate.Register(worker, "hello_go", helloGo); err != nil {
        log.Fatal(err)
    }
    log.Print("Worker listening. Publish its manifest in step 3.")
    ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
    defer cancel()
    <-ctx.Done()
}` },
  { id: 'java', label: 'Java', version: 'SDK 0.1.1 · Java 21+ · Early release', file: 'src/main/java/Main.java',
    docs: 'https://github.com/resonatehq/resonate-sdk-java#quickstart',
    install: 'gradle init --type java-application --dsl kotlin\n# Use the build.gradle.kts below in the application module.',
    buildFile: 'build.gradle.kts', build: `plugins { application }
repositories { mavenCentral() }
dependencies { implementation("io.resonatehq:resonate-sdk-java:0.1.1") }
java { toolchain { languageVersion = JavaLanguageVersion.of(21) } }
application { mainClass = "Main" }`, run: './gradlew run',
    note: 'Put the source file and build.gradle.kts in the generated application module (usually app/).',
    code: `import io.resonatehq.resonate.Context;
import io.resonatehq.resonate.Resonate;
import java.util.concurrent.CountDownLatch;

public final class Main {
    public record Input(String name) {}

    static String required(String name) {
        String value = System.getenv(name);
        if (value == null || value.isBlank()) throw new IllegalStateException("Set " + name);
        return value;
    }

    public static String greeting(Context ctx, String name) {
        return "Hello, " + name + "!";
    }

    public static String helloJava(Context ctx, Input input) {
        return ctx.run(Main::greeting, input.name()).await();
    }

    public static void main(String[] args) throws InterruptedException {
        Resonate worker = Resonate.builder()
            .url(required("RESONATE_URL"))
            .token(required("RESONATE_TOKEN"))
            .pid(required("WORKER_ID"))
            .group("hello-java-v1")
            .build();
        worker.register(Main::helloJava, "hello_java", 1);
        Runtime.getRuntime().addShutdownHook(new Thread(worker::stop));
        System.out.println("Worker listening. Publish its manifest in step 3.");
        new CountDownLatch(1).await();
    }
}` },
  { id: 'rust', label: 'Rust', version: 'SDK 0.6.0 · Early development', file: 'src/main.rs',
    docs: 'https://docs.resonatehq.io/develop/rust',
    install: 'cargo init --bin\ncargo add resonate-sdk@=0.6.0 --rename resonate\ncargo add tokio --features full\ncargo add serde --features derive', run: 'cargo run',
    code: `use resonate::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
struct Input { name: String }

#[resonate::function]
async fn greeting(name: String) -> Result<String> {
    Ok(format!("Hello, {}!", name))
}

#[resonate::function]
async fn hello_rust(ctx: &Context, input: Input) -> Result<String> {
    ctx.run(greeting, input.name).await
}

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("Set {}", name))
}

#[tokio::main]
async fn main() -> Result<()> {
    let worker = Resonate::new(ResonateConfig {
        url: Some(required("RESONATE_URL")),
        token: Some(required("RESONATE_TOKEN")),
        pid: Some(required("WORKER_ID")),
        group: Some("hello-rust-v1".into()),
        ..Default::default()
    });
    worker.register(hello_rust)?;
    worker.register(greeting)?;
    println!("Worker listening. Publish its manifest in step 3.");
    tokio::signal::ctrl_c().await.expect("Unable to listen for Ctrl-C");
    worker.stop().await?;
    Ok(())
}` }
];

// Endpoint strings are shell data. Credentials are always placeholders or env
// references, never actual project secrets from the Console session.
export const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function workerGuide(example, endpoint) {
  const name = `hello_${example.id}`, group = `hello-${example.id}-v1`;
  const descriptor = { name, version: 1, group, description: `A checkpointed greeting from ${example.label}.`, inputSchema };
  const presence = { group, functions: [{ name, version: 1 }] };
  const environment = `export RESONATE_URL=${shellQuote(endpoint)}
export RESONATE_TOKEN='<worker API key>'
export WORKER_ID='${name}-1'`;
  const publish = `#!/bin/sh
set -eu
: "\x24{RESONATE_URL:?Set RESONATE_URL}"
: "\x24{RESONATE_TOKEN:?Set RESONATE_TOKEN to a Worker API key}"
: "\x24{WORKER_ID:?Use the same WORKER_ID as your worker}"

curl --fail-with-body --silent --show-error --max-time 10 \\
  "$RESONATE_URL/v1/functions" \\
  -H "Authorization: Bearer $RESONATE_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d ${shellQuote(JSON.stringify(descriptor))} >/dev/null

offline() {
  curl --fail --silent --show-error --max-time 3 -X POST \\
    "$RESONATE_URL/v1/workers/$WORKER_ID/offline" \\
    -H "Authorization: Bearer $RESONATE_TOKEN" >/dev/null || :
}
trap offline EXIT
trap 'exit 0' INT TERM

while :; do
  curl --fail-with-body --silent --show-error --max-time 10 \\
    "$RESONATE_URL/v1/workers/$WORKER_ID/heartbeat" \\
    -H "Authorization: Bearer $RESONATE_TOKEN" \\
    -H 'Content-Type: application/json' \\
    -d ${shellQuote(JSON.stringify(presence))} >/dev/null
  sleep 20
done`;
  const invoke = `# Use an Agent / client key to create executions.
export RESONATE_URL=${shellQuote(endpoint)}
export RESONATE_CLIENT_TOKEN='<agent / client API key>'

curl --fail-with-body --silent --show-error "$RESONATE_URL/v1/executions" \\
  -H "Authorization: Bearer $RESONATE_CLIENT_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: ${name}-001' \\
  -d '${JSON.stringify({ function: name, version: 1, input: { name: 'Ada' } })}'

# Replace <execution-id> with the id from the response.
curl --fail-with-body --silent --show-error "$RESONATE_URL/v1/executions/<execution-id>" \\
  -H "Authorization: Bearer $RESONATE_CLIENT_TOKEN"`;
  return { name, group, descriptor, environment, publish, invoke };
}
