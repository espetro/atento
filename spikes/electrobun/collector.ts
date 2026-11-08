// Spike verification collector + trivial cookie endpoint for S3.
// GET /log?label=&result=  -> logs beacon
// GET /set?name=&value=    -> sets a cookie, returns HTML page
// GET /cookies             -> returns document.cookie as text
Bun.serve({
	port: 4799,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/log") {
			console.log(`[collector] ${url.searchParams.get("label")}: ${url.searchParams.get("result")}`);
			return new Response("ok");
		}
		if (url.pathname === "/set") {
			const name = url.searchParams.get("name") ?? "spike";
			const value = url.searchParams.get("value") ?? "1";
			return new Response(`<html><body>cookie set: ${name}=${value}</body></html>`, {
				headers: {
					"content-type": "text/html",
					"set-cookie": `${name}=${value}; Path=/; Max-Age=86400`,
				},
			});
		}
		if (url.pathname === "/cookies") {
			const who = url.searchParams.get("who") ?? "anon";
			return new Response(
				`<!doctype html><title>cookies-${who}</title><pre id="c">pending</pre><script>
					const c = document.cookie || "(none)";
					document.getElementById("c").textContent = c;
					fetch("/log?label=cookies-${who}&result=" + encodeURIComponent(c)).catch(() => {});
				</script>`,
				{ headers: { "content-type": "text/html" } },
			);
		}
		return new Response("collector", { status: 200 });
	},
});
console.log("collector on :4799");
