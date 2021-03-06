import {
	TextDocument,
	Position,
	Range,
	DiagnosticSeverity,
	Diagnostic,
	languages,
	Uri
} from "vscode";
import { tmpdir } from "os";
import { sep } from "path";
import { arrayInclude, trimBoth, getWorkspaceFolder } from "./utils";
import { execV } from "./exec";
import { resolve, relative, dirname } from "path";
import { readdirSync } from "fs";

const outDir = `${tmpdir()}${sep}vscode_vlang${sep}`;
const SEV_ERR = DiagnosticSeverity.Error;
const SEV_WRN = DiagnosticSeverity.Warning;

export interface ErrorInfo {
	file: string;
	line: number;
	column: number;
	message: string;
	stderr: string;
}

interface MoreInfo {
	for: number;
	content: string;
}

export const collection = languages.createDiagnosticCollection("V");

export function lint(document: TextDocument): boolean {
	const workspaceFolder = getWorkspaceFolder(document.uri);
	// Don't lint files that are not in the workspace
	if (!workspaceFolder) return true;

	const cwd = workspaceFolder.uri.fsPath;
	const foldername = dirname(document.fileName);
	const relativeFoldername = relative(cwd, foldername);
	const relativeFilename = relative(cwd, document.fileName);
	const fileCount = readdirSync(foldername).filter(f => f.endsWith(".v")).length;

	let target = foldername === cwd ? "." : relativeFoldername;
	target = fileCount === 1 ? relativeFilename : target;

	let status = true;

	execV(["-o", `${outDir}lint.c`, target], (err, stdout, stderr) => {
		collection.clear()
		if (err || stderr.trim().length > 1) {
			const output = stderr || stdout;
			const isWarning = output.substring(0, 7) === "warning";

			if (!isWarning) {
				/* ERROR */
				const { file, line, column, message } = parseError(output);
				const fileuri = Uri.file(resolve(cwd, file));
				const start = new Position(line - 1, column);
				const end = new Position(line - 1, column + 1);
				const range = new Range(start, end);
				const diagnostic = new Diagnostic(range, message, SEV_ERR);
				diagnostic.source = "V";
				collection.set(fileuri, [diagnostic]);
			} else {
				/* WARNING */
				const warnings = parseWarning(output);
				warnings.forEach(warning => {
					const { file, line, column, message } = warning;
					const fileuri = Uri.file(resolve(cwd, file));
					const start = new Position(line - 1, column);
					const end = new Position(line - 1, column + 1);
					const range = new Range(start, end);
					const diagnostic = new Diagnostic(range, message, SEV_WRN);
					diagnostic.source = "V";
					collection.set(fileuri, [...collection.get(fileuri), diagnostic]);
				});
			}
			return (status = false);
		} else {
			collection.delete(document.uri);
		}
	});
	return status;
}

function parseWarning(stderr: string): Array<ErrorInfo> {
	stderr = trimBoth(stderr);
	const lines = stderr.split("\n");
	const warnings: Array<ErrorInfo> = [];
	const moreInfos: Array<MoreInfo> = [];

	for (let ln of lines) {
		ln = trimBoth(ln);
		const cols = ln.split(":");

		if (cols.length < 5 && ln.startsWith("*")) {
			const obj = { for: warnings.length - 1, content: ln };
			moreInfos.push(obj);
		} else {
			const file = trimBoth(cols[1]);
			const line = parseInt(cols[2]);
			const column = parseInt(cols[3]);
			const message = trimBoth(cols[4]);
			warnings.push({ file, line, column, message, stderr });
		}
	}

	moreInfos.forEach(moreInfo => {
		warnings[moreInfo.for].message += `\n ${moreInfo.content}`;
	});

	return warnings;
}

function parseError(stderr: string): ErrorInfo {
	stderr = stderr.replace(/^\s*$[\n\r]{1,}/gm, "");
	const split = stderr.split("\n");
	const index = arrayInclude(split, ".v:");
	const moreMsgIndex = arrayInclude(split, " *");
	const infos = (split[index] || "").split(":");

	const file = trimBoth(infos[0]);
	const line = parseInt(infos[1]);
	const column = parseInt(infos[2]);
	let message = trimBoth(infos.slice(3).join(""));

	if (split[moreMsgIndex]) message += ":\n" + trimBoth(split[moreMsgIndex]);

	return { file, line, column, message, stderr };
}
