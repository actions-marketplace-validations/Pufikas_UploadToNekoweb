const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const pLimit = require("p-limit").default;
const archiver = require("archiver");

const limit = pLimit(10);
const { APIKEY, DOMAIN, USERNAME, IGNORE_PATHS, COMPRESSION_LEVEL } = process.env;
const API = "https://nekoweb.org/api";

const SITE_DIR = path.join(process.cwd(), "site");
const ZIP_PATH = path.join(process.cwd(), "deploy.zip");

let totalBytes = 0;
let ignoredBytes = 0;

// default ignore file list
const DEFAULT_IGNORE = new Set([
	".git",
	".github",
	"node_modules",
	"deploytonekoweb",
]);

const userSpecifiedIgnores = IGNORE_PATHS
	?.split(",")
	.map(p => p.trim())
	.filter(Boolean) ?? [];

const IGNORE = new Set([...DEFAULT_IGNORE, ...userSpecifiedIgnores].map(p => p.replace(/\/+$/, ""))); // removes the trailing slashes like assets/bg/ => assets/bg

async function zipDirectory(inputDir, outputZipPath) {
	const output = fs.createWriteStream(outputZipPath)
	const archive = archiver('zip', {
		zlib: { level: COMPRESSION_LEVEL }
	});

	archive.pipe(output);

	async function addFiles(dir, zipDir = "") {
		const entries = await fsp.readdir(dir, { withFileTypes: true });

		const tasks = entries.map(entry => {
			const full = path.join(dir, entry.name);
			const relPath = path.relative(SITE_DIR, full);
			const zipPath = `${zipDir}/${entry.name}`.replace(/\\/g, "/");

			if (shouldIgnore(relPath)) {
				return Promise.resolve().then(async () => {
					if (!entry.isDirectory()) {
						const stat = await fsp.stat(full);
						ignoredBytes += stat.size;
					}
					console.log(`skipping: ${relPath}`);
				});
			}

			if (entry.isDirectory()) {
				return addFiles(full, zipPath);
			}

			return limit(async () => {
				const stat = await fsp.stat(full);
				totalBytes += stat.size;
				archive.file(full, { name: zipPath });
			});
		});

		await Promise.all(tasks);
	}

	await addFiles(inputDir, DOMAIN);
	await archive.finalize();

	await new Promise((resolve, reject) => {
		output.on("close", resolve);
		output.on("error", reject);
	});
}

function shouldIgnore(relPath) {
	for (const ignore of IGNORE) {
		if (relPath === ignore || relPath.startsWith(ignore + "/")) {
			return true;
		}
	}
	return false;
}

async function apiFetch(url, options = {}) {
	const res = await fetch(url, {
		...options,
		headers: {
			Authorization: APIKEY,
			...(options.headers || {})
		}
	});

	const text = await res.text();

	if (!res.ok) {
		throw new Error(`API ${res.status}: ${text}`);
	}

	return text;
}

async function getZipId() {
	const res = await apiFetch(`${API}/files/big/create`, { method: "GET" });
	const json = JSON.parse(res);

	return json.id;
}

async function appendZip(id, filePath) {
	const form = new FormData();
	form.append("id", id);
	form.append(
		"file",
		new Blob([fs.readFileSync(filePath)], { type: "application/zip" }),
		"deploy.zip"
	);

	await apiFetch(`${API}/files/big/append`, { method: "POST", body: form });
}

async function importZip(id) {
	await apiFetch(`${API}/files/import/${id}`, { method: "POST" });
}

(async () => {
	await zipDirectory(SITE_DIR, ZIP_PATH);
	const id = await getZipId();

	await appendZip(id, ZIP_PATH);

	await importZip(id);

	console.log(`done uploading`);
	console.log(`total files size: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
	console.log(`ignored files size: ${(ignoredBytes / 1024 / 1024).toFixed(2)} MB`);
	console.log(`zip size: ${(fs.statSync(ZIP_PATH).size / 1024 / 1024).toFixed(2)} MB`);
	console.log(`saved (raw): ${((ignoredBytes / totalBytes) * 100).toFixed(1)}%`);

})().catch(err => {
	console.error(`err: ${err}`);
});
