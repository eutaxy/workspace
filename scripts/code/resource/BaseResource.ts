import fs from "fs";
import path from "path";
import yaml from "yaml";
import { glob } from "glob";
import { Cacheable } from "../decorator/Cache";

import {
  convertManifestValue,
  defaultManifestOptions,
  type IResourceManifest,
  type ResourceManifestScripts,
  type ResourceResolvedItem,
  type ResourceResolvedScripts,
  type ResourceScript,
  type ResourceScriptEnv,
} from "../types/Manifest";
import { GLOBAL_ENV } from "../Build";
import { normalize, sanitizeBrackets } from "../../Utils";
import { BUNDLE_SCRIPTS, CACHE_FOLDER, DIST_FOLDER } from "../../Consts";
import { ScriptResource } from "./ScriptResource";
import type { IResourceHooks } from "../types/Hooks";

export type BuildOptions = {
  force: boolean;
  reloadManifest: boolean;
};

export type BuildResult =
  | { success: true; data: { resourceInclusions: string[] } }
  | { success: false; message: string };

export const DEFAULT_BUILD_OPTIONS: BuildOptions = {
  force: false,
  reloadManifest: false,
};

export class BaseResource {
  //
  // Singleton
  //

  private static _instances: { [key: string]: BaseResource } = {};
  public static create(name: string, resourceRoot: string): BaseResource {
    if (!this._instances[name])
      this._instances[name] = new ScriptResource(name, resourceRoot);

    return this._instances[name];
  }

  //
  // Instance
  //

  protected _manifest: Partial<IResourceManifest> = {};
  protected _env: { [key: string]: string } = {};
  protected _outputTarget: string;

  public get name(): string {
    return this._name;
  }

  public get manifest(): IResourceManifest {
    return this._manifest as IResourceManifest;
  }

  constructor(protected _name: string, protected _resourceRoot: string) {
    this._outputTarget = normalize(
      path.join(DIST_FOLDER, "server-data/resources/", _name)
    );

    try {
      const manifestContent = fs.readFileSync(
        path.join(_resourceRoot, "manifest.yaml"),
        "utf-8"
      );
      if (!manifestContent) throw new Error("Failed to load manifest.");

      this._manifest = yaml.parse(manifestContent) as IResourceManifest;
    } catch (error) {
      console.error(`Failed to load manifest for resource ${_name}`);
      console.error(error);
    }

    this._env = GLOBAL_ENV;
    if (this?._manifest?.env)
      for (const key in this._manifest.env) this._env[key] = this._manifest.env[key];
  }

  public async build(
    options: Partial<BuildOptions> = DEFAULT_BUILD_OPTIONS
  ): Promise<BuildResult> {
    console.error("Build method not implemented.");
    return { success: false, message: "Not implemented." };
  }

  // @Cacheable((args) => `filePath:${args[0]}`)
  public getResourceFile(filePath: ResourceScript): Array<{
    manifestPath: string;
    sourcePath: string;
  }> {
    const scan = glob.sync(`${glob.escape(this._resourceRoot)}/${normalize(filePath)}`);

    return scan.map((file) => ({
      manifestPath: normalize(path.relative(this._resourceRoot, file)),
      sourcePath: normalize(file),
    }));
  }

  // @Cacheable((args) => `resolve:${args[0]}`)
  public resolveFilePath(filePath: string): Array<ResourceResolvedItem> {
    const matched = /^\$([a-zA-Z0-9_\-]{1,24})\/(.*?)(?::(.*))?$/gm.exec(filePath);
    if (matched) {
      const [_, resourceName, innerPath, targetPath] = matched;

      let resourcePath = glob
        .sync(`./src/**/${resourceName}/manifest.yaml`)
        .map((file) => normalize(file))
        .at(0);

      if (!resourcePath) return [];
      resourcePath = path.dirname(resourcePath);

      const targetResource = BaseResource.create(resourceName, resourcePath);
      const resolved = targetResource.getResourceFile(innerPath);

      if (targetPath && resolved.length > 1) {
        throw new Error(`Cannot resolve multiple files with target path: ${targetPath}`);
      }

      return resolved.map((x) => ({
        resourceName: targetResource._name,

        source: x.sourcePath,
        sourceManifest: x.manifestPath,

        target: normalize(
          path.join(
            normalize(this._outputTarget),
            "_imports",
            targetResource._name,
            x.manifestPath
          )
        ),
        targetManifest: normalize(
          path.join("_imports", targetResource._name, targetPath || x.manifestPath)
        ),
      }));
    }

    const searchPattern = sanitizeBrackets(
      normalize(path.join(this._resourceRoot, filePath))
    );
    const scan = glob.sync(searchPattern);

    return scan.map((file) => ({
      resourceName: this._name,

      source: normalize(file),
      sourceManifest: normalize(path.relative(this._resourceRoot, file)),

      target: normalize(
        path.join(this._outputTarget, path.relative(this._resourceRoot, file))
      ),
      targetManifest: normalize(path.relative(this._resourceRoot, file)),
    }));
  }

  protected copyResourceFiles() {
    if (!this._manifest?.files) return;

    for (const file of this._manifest.files) {
      if (typeof file !== "string" && file.skipCopy) continue;

      const resolved = this.resolveFilePath(typeof file === "string" ? file : file.src);
      for (const fileItem of resolved) {
        const targetPath = path.dirname(fileItem.target);
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

        fs.copyFileSync(fileItem.source, fileItem.target);
      }
    }
  }

  protected generateResourceManifest(scripts: ResourceManifestScripts): void {
    let outputString = "";
    const manifest = this._manifest as IResourceManifest;

    if (manifest.info) {
      outputString += `--[[\n`;

      for (const key in manifest.info) {
        // @ts-ignore
        outputString += `\t@${key} ${manifest.info[key]}\n`;
      }

      outputString += `]]\n\n`;
    }

    // setup important manifest infos
    for (const key of [
      "fx_version",
      "game",
      "use_fxv2_oal",
      "lua54",
      "ui_page",

      // "resource_manifest_version",
    ] as (keyof IResourceManifest)[]) {
      const value =
        manifest[key as keyof IResourceManifest] || defaultManifestOptions[key];
      if (!value) continue;

      outputString += `${key} ${convertManifestValue(value)}\n`;
    }

    outputString += `\n\n`;

    if (BUNDLE_SCRIPTS) {
      if (fs.existsSync(path.join(this._outputTarget, "server_bundle.lua")))
        outputString += `server_script 'server_bundle.lua'\n`;

      if (fs.existsSync(path.join(this._outputTarget, "client_bundle.lua")))
        outputString += `client_script 'client_bundle.lua'\n`;
    } else {
      for (const scriptEnv of ["server", "client"] as ResourceScriptEnv[]) {
        outputString += `${scriptEnv}_scripts {\n`;

        if (scripts.shared)
          for (const script of scripts.shared) outputString += `\t"${script}",\n`;

        if (scripts[scriptEnv])
          for (const script of scripts[scriptEnv]) outputString += `\t"${script}",\n`;

        outputString += "}\n\n";
      }
    }

    if (manifest?.files) {
      outputString += `files {\n`;

      for (const file of manifest.files) {
        if (typeof file !== "string" && file.serverOnly) continue;

        if (typeof file !== "string" && file.skipResolve)
          outputString += `\t'${file.src}',\n`;

        const filePath = typeof file === "string" ? file : file.src;
        const resolved = this.resolveFilePath(filePath);

        for (const fileItem of resolved)
          outputString += `\t'${fileItem.targetManifest}',\n`;
      }

      outputString += "}\n\n";
    }

    if (manifest?.exports) {
      for (const env of ["shared", "server", "client"] as ResourceScriptEnv[]) {
        outputString += `${env}_exports {\n`;

        for (const exportItem of manifest.exports) {
          const exportEnv =
            typeof exportItem === "string" ? {} : exportItem.env ?? "server";
          if (exportEnv !== env) continue;

          const funcName =
            typeof exportItem === "string" ? exportItem : exportItem.function;
          outputString += `\t"${funcName}",\n`;
        }

        outputString += "}\n\n";
      }
    }

    // write to file
    fs.writeFileSync(path.join(this._outputTarget, "fxmanifest.lua"), outputString);
  }

  protected async callHook<E extends keyof IResourceHooks>(
    hookName: E,
    data: Parameters<IResourceHooks[E]>[0] = undefined
  ): Promise<ReturnType<IResourceHooks[E]> | null> {
    if (!this._manifest?.hooks?.[hookName]) return null;

    const hookPath = path.resolve(
      path.join(this._resourceRoot, this._manifest.hooks[hookName])
    );
    if (!fs.existsSync(hookPath)) {
      console.error(
        `Hook ${hookName} for resource ${this._name} at '${hookPath}' does not exist.`
      );

      return null;
    }

    try {
      const hookModule = await import(hookPath);
      if (!hookModule) return null;

      const result = await hookModule.default({
        resourceName: this._name,
        resourcePath: normalize(path.resolve(this._resourceRoot)),
        outputTarget: this._outputTarget,
        manifest: this._manifest,

        data,
      });

      this._manifest = result.ctx.manifest;

      return result.returned;
    } catch (error) {
      console.error(`Failed to call hook ${hookName} for resource ${this._name}`);
      console.error(error);
      return null;
    }
  }

  public async deleteBuildFolder() {
    fs.rmdirSync(path.join(CACHE_FOLDER, "build", this._name), { recursive: true });
  }
}
