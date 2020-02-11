import * as vscode from 'vscode';

import * as path from 'path';
import * as os from 'os';

import { OneApiCli, SampleContainer } from './oneapicli';

//Fairly basic regex for searching for URLs in a string.
const r = /(https?:\/\/[^\s]+)/g;

export class SampleTreeItem extends vscode.TreeItem {


    constructor(
        public readonly label: string,

        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public description: string,
        public val?: SampleContainer,
        public children?: Map<string, SampleTreeItem>,
        public contextValue: string = "sample",
        public readonly command?: vscode.Command,

    ) {
        super(label, collapsibleState);
    }

    get tooltip(): string {
        return this.description;
    }
}

export class SampleProvider implements vscode.TreeDataProvider<SampleTreeItem> {

    private _onDidChangeTreeData: vscode.EventEmitter<SampleTreeItem | undefined> = new vscode.EventEmitter<SampleTreeItem | undefined>();
    readonly onDidChangeTreeData: vscode.Event<SampleTreeItem | undefined> = this._onDidChangeTreeData.event;

    private cli = new OneApiCli(this.askDownloadPermission);
    private language = "";

    constructor() {
        this.updateCLIConfig();
    }

    private async updateCLIConfig(): Promise<void> {
        const config = vscode.workspace.getConfiguration("inteloneapi.samples");
        const languageValue: string | undefined = config.get('sampleLanguage');

        if (!languageValue || languageValue === "") {
            vscode.window.showErrorMessage("Configured language is empty, Intel oneAPI sample browser cannot operate");
        }
        this.language = languageValue as string;


        const cliPath: string | undefined = config.get('pathToCLI');
        if (cliPath) {
            {
                this.cli.cli = cliPath;
            }
        }
        const baseURL: string | undefined = config.get('baseURL');
        if (baseURL) {
            this.cli.baseURL = baseURL;
        }
    }


    async refresh(): Promise<void> {
        await this.updateCLIConfig();
        this._onDidChangeTreeData.fire();

    }
    async clean(): Promise<void> {
        await this.cli.cleanCache();
        this.refresh();
    }


    getTreeItem(element: SampleTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: SampleTreeItem | undefined): vscode.ProviderResult<SampleTreeItem[]> {
        if (element) {
            return this.getSortedChildren(element);
        } else {
            return this.getIndex();
        }
    }
    private linkify(text: string): string {
        return text.replace(r, url => {
            return `[${url}](${url})`; //Vscode Markdown needs explict href and text
        });
    }

    async create(sample: SampleTreeItem): Promise<void> {
        const val = sample.val;

        //Dependency Check 
        const skipCheck: boolean = vscode.workspace.getConfiguration("inteloneapi.samples").get('skipDependencyChecks') as boolean;
        if (val?.example.dependencies && !skipCheck) {
            if (!process.env.ONEAPI_ROOT) {
                vscode.window.
                    showWarningMessage("FYI, This sample has a depedency but ONEAPI_ROOT is not set so we can not check if the depdencies are met");

            } else {
                const output = await this.cli.checkDependencies(val.example.dependencies.join());
                if (output !== "") {
                    //Just show output from the CLI as other Browser currently do.
                    const r = await vscode.window.showWarningMessage(this.linkify(output), "Cancel", "Continue");
                    if (r === "Cancel") {
                        return;
                    }
                }
            }
        }

        const folder = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
        if (val && folder && folder[0]) { //Check Value for sample creation was passed, and the folder selection was defined.
            try {
                this.cli.createSample(val.path, folder[0].fsPath);
            }
            catch (e) {
                vscode.window.showErrorMessage(`Sample Creation failed: ${e}`);
                return;
            }
            vscode.commands.executeCommand("vscode.openFolder", folder[0], true);
        }
    }
    async show(sample: SampleContainer): Promise<void> {
        const p = path.join(os.tmpdir(), os.userInfo().username, sample.path);

        try {
            await this.cli.createSample(sample.path, p);
        }
        catch (e) {
            vscode.window.showErrorMessage(e);
            return;
        }

        const a = path.join(p, "README.md");
        vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.file(a));
    }

    public async askDownloadPermission(): Promise<boolean> {
        const sel = await vscode.window.showInformationMessage("Required 'oneapi-cli' was not found on the Path, Do you want to download it", "Yes", "No");
        return (sel === "Yes");
    }

    /**
     * Add sample to tree structure.
     * @param key Key, is the potentential categories i.e [mycategory, mysubcategory]
     * @param pos is the partent element in the tree i.e. the owneing category
     * @param ins Sample to be inserted into tree.
     */
    private addSample(key: string[], pos: Map<string, SampleTreeItem>, ins: SampleContainer): void {
        if (key.length < 1) {
            //Add Sample
            const add = new SampleTreeItem(ins.example.name, vscode.TreeItemCollapsibleState.None, ins.example.description, ins, undefined, undefined,
                { command: "intel.oneAPISamples.show", title: "", arguments: [ins] });
            pos.set(ins.path, add);
            return;
        }
        const cKey = key.shift();
        if (cKey) {
            if (!pos.has(cKey)) {
                const newMap = new Map<string, SampleTreeItem>();
                const addCat = new SampleTreeItem(cKey, vscode.TreeItemCollapsibleState.Expanded, "", undefined, newMap, "cat");
                pos.set(cKey, addCat);
            }
            const category: SampleTreeItem | undefined = pos.get(cKey);
            if (category) {
                const children: Map<string, SampleTreeItem> | undefined = category.children;
                if (children) {
                    this.addSample(key, children, ins);
                }
            }
        }
    }

    private async getSortedChildren(node: SampleTreeItem): Promise<SampleTreeItem[]> {
        if (node.children) {
            const r = Array.from(node.children.values());
            return this.sort(r);
        }
        return [];
    }


    private async getIndex(): Promise<SampleTreeItem[]> {
        let clierror = false;
        await this.cli.ready.catch(() => {
            clierror = true;

        });
        if (clierror) {
            vscode.window.showErrorMessage("Unable to find oneapi-cli or download it");
            const fail = new SampleTreeItem("Unable to find oneapi-cli or download it", vscode.TreeItemCollapsibleState.None, "", undefined, undefined, "blankO");
            return [fail];

        }

        const sampleArray: SampleContainer[] = await this.cli.fetchSamples(this.language);
        const root = new Map<string, SampleTreeItem>();

        for (const sample of sampleArray) {
            if (!sample.example.categories || sample.example.categories.length === 0) {
                sample.example.categories = ["Other"];
            }
            for (const categories of sample.example.categories) {
                const catPath = categories.split('/');
                if (catPath[0] === "Toolkit") {
                    catPath.shift();
                }
                this.addSample(catPath, root, sample);
            }
        }
        const tree = Array.from(root.values());
        return this.sort(tree);
    }

    private sort(nodes: SampleTreeItem[]): SampleTreeItem[] {
        return nodes.sort((n1, n2) => {
            return n1.label.localeCompare(n2.label);
        });
    }

}
