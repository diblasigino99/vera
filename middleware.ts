import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  const adminPassword = process.env.ADMIN_PASSWORD;
  const adminUsername = process.env.ADMIN_USERNAME ?? "admin";

  if (!adminPassword) {
    return new NextResponse("Admin dashboard is not configured.", {
      status: 503,
      headers: {
        "content-type": "text/plain; charset=utf-8"
      }
    });
  }

  const authorization = request.headers.get("authorization");

  if (authorization?.startsWith("Basic ")) {
    const encoded = authorization.slice("Basic ".length);
    const decoded = safeBase64Decode(encoded);
    const separatorIndex = decoded.indexOf(":");
    const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : "";
    const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

    if (username === adminUsername && password === adminPassword) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "www-authenticate": 'Basic realm="Vera Admin", charset="UTF-8"'
    }
  });
}

export const config = {
  matcher: "/admin/:path*"
};

function safeBase64Decode(value: string) {
  try {
    return atob(value);
  } catch {
    return "";
  }
}
