// Spike verification collector: logs ?label=&result= beacons to stdout.
Bun.serve({
	port: 4799,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/log") {
			console.log(`[collector] ${url.searchParams.get("label")}: ${url.searchParams.get("result")}`);
			return new Response("ok");
		}
		return new Response("collector", { status: 200 });
	},
});
console.log("collector on :4799");
