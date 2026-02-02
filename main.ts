import { Application, send } from "@oak/oak";
import { Router, RouterContext } from "@oak/oak/router";
import { Session } from "https://deno.land/x/oak_sessions@v9.0.0/mod.ts";
import { OAuth2Client } from "@cmd-johnson/oauth2-client";

const port = 5353;

const oauth2Client = new OAuth2Client({
  clientId: Deno.env.get("CLIENT_ID")!,
  clientSecret: Deno.env.get("CLIENT_SECRET"),
  authorizationEndpointUri: "https://www.recurse.com/oauth/authorize",
  tokenUri: "https://www.recurse.com/oauth/token",
  redirectUri: Deno.env.get("REDIRECT_URI"),
});

type Tokens = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken: string;
};
const cookies = {
  async setTokens(ctx: Ctx, tokens: Tokens) {
    return await ctx.cookies.set("tokens", JSON.stringify(tokens), {
      secure: Deno.env.get("REDIRECT_URI")?.startsWith("https"),
      ignoreInsecure: true,
      sameSite: true,
      httpOnly: true,
    });
  },
  async getTokens(ctx: Ctx): Promise<Tokens | undefined> {
    const cookies = await ctx.cookies.get("tokens");
    if (cookies === undefined) return;
    return JSON.parse(cookies);
  },
  async refreshTokens(ctx: Ctx, refreshToken: string) {
    try {
      const newTokens = await oauth2Client.refreshToken.refresh(
        refreshToken,
      );
      return await this.setTokens(ctx, newTokens);
    } catch (error) {
      return false;
    }
  },
  async deleteTokens(ctx: Ctx) {
    await ctx.cookies.delete("tokens");
  },
};

type Status = {
  last_emptied: string;
  last_cleaned: string;
};
const status = {
  path: "/data/status.json",
  async read() {
    try {
      const data = await Deno.readTextFile(this.path);
      return JSON.parse(data) as Status;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        const status: Status = {
          last_emptied: new Date().toISOString(),
          last_cleaned: new Date().toISOString(),
        };
        await Deno.mkdir("/data", { recursive: true });
        await Deno.writeTextFile(this.path, JSON.stringify(status));
        return status;
      } else {
        throw error;
      }
    }
  },
  async write(data: Status) {
    const dataStr = JSON.stringify(data, null, 2);
    await Deno.writeTextFile(this.path, dataStr);
  },
};

type Me = {
  first_name: string;
};
type Ctx = RouterContext<any, any, any>;

const getName = async (ctx: Ctx) => {
  const tokens = await cookies.getTokens(ctx);
  if (tokens === undefined) {
    ctx.response.status = 401;
    ctx.response.body = { message: "not logged in" };
    return false;
  }

  const name = await fetchRcApi(tokens.accessToken);
  if (name === false) {
    await cookies.refreshTokens(ctx, tokens.refreshToken);

    const newTokens = await cookies.getTokens(ctx);
    if (newTokens === undefined) {
      await ctx.cookies.delete("tokens");
      ctx.response.status = 401;
      ctx.response.body = { message: "invalid session" };
      return false;
    }

    const name = await fetchRcApi(newTokens.accessToken);
    if (name === false) {
      await ctx.cookies.delete("tokens");
      ctx.response.status = 401;
      ctx.response.body = { message: "invalid session" };
      return false;
    }
  }
  return name;
};

const fetchRcApi = async (accessToken: string) => {
  const rcApiResponse = await fetch(
    "https://www.recurse.com/api/v1/profiles/me",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (rcApiResponse.status === 200) {
    const json = await rcApiResponse.json() as Me;
    return { first_name: json.first_name } as Me;
  }
  return false;
};

const router = new Router<AppState>();

// oauth

router.get("/api/login", async (ctx) => {
  const { uri, codeVerifier } = await oauth2Client.code.getAuthorizationUri();
  ctx.state.session.flash("codeVerifier", codeVerifier);
  ctx.response.redirect(uri);
});

router.get("/api/logout", async (ctx) => {
  await cookies.deleteTokens(ctx);
  await ctx.state.session.deleteSession();
  ctx.response.redirect("/");
});

router.get("/api/callback", async (ctx) => {
  const codeVerifier = ctx.state.session.get("codeVerifier");
  if (typeof codeVerifier !== "string") {
    throw new Error("invalid codeVerifier");
  }

  const tokens = await oauth2Client.code.getToken(ctx.request.url, {
    codeVerifier,
  });
  await cookies.setTokens(ctx, tokens);
  ctx.response.redirect("/");
});

// api

router.get("/api/me", async (ctx) => {
  const me = await getName(ctx);
  if (me === false) return;
  ctx.response.body = me;
});

router.get("/api/status", async (ctx) => {
  ctx.response.body = await status.read();
});

router.all("/api/status/:key", async (ctx) => {
  if (!["POST", "GET"].includes(ctx.request.method)) {
    ctx.response.status = 405;
    return;
  }

  const me = await getName(ctx);
  if (me === false) {
    if (ctx.request.method === "GET") {
      return ctx.response.redirect("/api/login");
    }
    if (ctx.request.method === "POST") {
      return;
    }
  }

  const currentStatus = await status.read();

  if (!new Set(Object.keys(currentStatus)).has(ctx.params.key)) {
    ctx.response.status = 400;
    ctx.response.body = { message: "invalid key" };
    return;
  }

  await status.write({
    ...currentStatus,
    [ctx.params.key]: new Date("2026-01-29T15:32:41.000Z").toISOString(),
  });

  if (ctx.request.method === "GET") {
    return ctx.response.redirect("/");
  }
  if (ctx.request.method === "POST") {
    ctx.response.body = await status.read();
  }
});

// main

type AppState = {
  session: Session;
};

const app = new Application<AppState>({ proxy: true });
app.use(Session.initMiddleware());
app.use(router.allowedMethods(), router.routes());

// static

app.use(async (ctx) => {
  if (!ctx.request.url.pathname.startsWith("/api")) {
    await send(ctx, ctx.request.url.pathname, {
      root: "static",
      index: "index.html",
    });
  }
});

await app.listen({ port });
