import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import puppeteer, { Page, Browser} from "puppeteer";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";


const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  constraints?: {
    horizontal: string;
    vertical: string;
  };
  fills?: any[];
  strokes?: any[];
  effects?: any[];
  characters?: string;
  style?: any;
  children?: FigmaNode[];
}

interface FigmaFile {
  document: FigmaNode;
  components: Record<string, any>;
  schemaVersion: number;
  styles: Record<string, any>;
}

interface ViewportSize {
  name: string;
  width: number;
  height: number;
}

interface ElementInfo {
  selector: string;
  name: string;
  dimensions: {
    width: number;
    height: number;
    x: number;
    y: number;
  };
  computed: {
    marginTop: string;
    marginRight: string;
    marginBottom: string;
    marginLeft: string;
    paddingTop: string;
    paddingRight: string;
    paddingBottom: string;
    paddingLeft: string;
    borderWidth: string;
    fontSize: string;
    fontFamily: string;
    color: string;
    backgroundColor: string;
    display: string;
    position: string;
    zIndex: string;
  };
}

interface ComparisonResult {
  figmaNode: FigmaNode;
  actualElement: ElementInfo;
  differences: {
    property: string;
    figmaValue: any;
    actualValue: any;
    difference: number | string;
  }[];
  viewport: ViewportSize;
  screenshot: string;
}

class FigmaDesignVerificationServer {
  private server: McpServer;
  private figmaToken: string = "";
  private localServerUrl: string = "";
  private browser: Browser | null = null;

  constructor() {
    this.server = new McpServer({
      name: "figma-design-verification",
      version: "1.0.0",
    });

    this.setupTools();
  }

  private setupTools() {
    // Configure Figma API access
    this.server.registerTool(
      "configure-figma-access",
      {
        title: "Configure Figma Access",
        description: "Set up Figma API token and local server URL",
        inputSchema: {
          figmaToken: z.string().describe("Figma API access token"),
          localServerUrl: z.string().describe("Local development server URL (e.g., http://localhost:3000)"),
        },
      },
      async ({ figmaToken, localServerUrl }) => {
        this.figmaToken = figmaToken;
        this.localServerUrl = localServerUrl;
        
        return {
          content: [{
            type: "text",
            text: `Configuration updated:\n- Figma API token: ${figmaToken.substring(0, 10)}...\n- Local server URL: ${localServerUrl}`
          }]
        };
      }
    );

    // Get Figma file information
    this.server.registerTool(
      "get-figma-file",
      {
        title: "Get Figma File",
        description: "Retrieve Figma file data with node information",
        inputSchema: {
          fileId: z.string().describe("Figma file ID"),
        },
      },
      async ({ fileId }) => {
        if (!this.figmaToken) {
          throw new Error("Figma API token not configured. Use configure-figma-access first.");
        }

        try {
          const response = await fetch(`https://api.figma.com/v1/files/${fileId}`, {
            headers: {
              'X-Figma-Token': this.figmaToken,
            },
          });

          if (!response.ok) {
            throw new Error(`Figma API error: ${response.status} ${response.statusText}`);
          }

          const data: FigmaFile = await response.json();
          
          // Extract all nodes with dimensions
          const nodes = this.extractNodesWithDimensions(data.document);

          return {
            content: [{
              type: "text",
              text: `Figma file retrieved successfully!\n\nFile: ${data.document.name}\nNodes found: ${nodes.length}\n\nNodes with dimensions:\n${nodes.map(node => `- ${node.name} (${node.type}): ${node.absoluteBoundingBox?.width}x${node.absoluteBoundingBox?.height}`).join('\n')}`
            }]
          };
        } catch (error) {
          throw new Error(`Failed to fetch Figma file: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    );

    // Analyze design at different viewport sizes
    this.server.registerTool(
      "analyze-design-implementation",
      {
        title: "Analyze Design Implementation",
        description: "Compare Figma design with local implementation across viewport sizes",
        inputSchema: {
          figmaFileId: z.string().describe("Figma file ID"),
          pageName: z.string().optional().describe("Specific page name to analyze"),
          viewportSizes: z.array(z.object({
            name: z.string(),
            width: z.number(),
            height: z.number(),
          })).optional().describe("Viewport sizes to test"),
          elementSelectors: z.array(z.string()).optional().describe("CSS selectors for elements to compare"),
        },
      },
      async ({ figmaFileId, pageName, viewportSizes, elementSelectors }) => {
        if (!this.figmaToken || !this.localServerUrl) {
          throw new Error("Configuration required. Use configure-figma-access first.");
        }

        const defaultViewports: ViewportSize[] = [
          { name: "Mobile", width: 375, height: 667 },
          { name: "Tablet", width: 768, height: 1024 },
          { name: "Desktop", width: 1440, height: 900 },
        ];

        const viewports = viewportSizes || defaultViewports;
        
        try {
          // Get Figma file data
          const figmaResponse = await fetch(`https://api.figma.com/v1/files/${figmaFileId}`, {
            headers: {
              'X-Figma-Token': this.figmaToken,
            },
          });

          if (!figmaResponse.ok) {
            throw new Error(`Figma API error: ${figmaResponse.status}`);
          }

          const figmaData: FigmaFile = await figmaResponse.json();
          const figmaNodes = this.extractNodesWithDimensions(figmaData.document);

          // Initialize browser
          this.browser = await puppeteer.launch({ headless: true });
          
          const results: ComparisonResult[] = [];

          // Analyze each viewport size
          for (const viewport of viewports) {
            const page = await this.browser.newPage();
            await page.setViewport({ width: viewport.width, height: viewport.height });
            
            try {
              await page.goto(this.localServerUrl, { waitUntil: 'networkidle2' });
              
              // Take screenshot
              const screenshotPath = await this.takeAnnotatedScreenshot(page, viewport);
              
              // Get element information
              const elements = await this.getElementsInfo(page, elementSelectors);
              
              // Compare with Figma nodes
              for (const element of elements) {
                const matchingFigmaNode = this.findMatchingFigmaNode(figmaNodes, element);
                if (matchingFigmaNode) {
                  const comparison = this.compareElementWithFigmaNode(element, matchingFigmaNode, viewport, screenshotPath);
                  results.push(comparison);
                }
              }
            } finally {
              await page.close();
            }
          }

          // Generate report
          const report = await this.generateReport(results);
          
          return {
            content: [{
              type: "text",
              text: `Design implementation analysis completed!\n\nViewports analyzed: ${viewports.length}\nElements compared: ${results.length}\n\nReport generated: ${report.reportPath}\n\nSummary:\n${report.summary}`
            }]
          };
        } catch (error) {
          throw new Error(`Analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        } finally {
          if (this.browser) {
            await this.browser.close();
            this.browser = null;
          }
        }
      }
    );

    // Generate detailed report
    this.server.registerTool(
      "generate-detailed-report",
      {
        title: "Generate Detailed Report",
        description: "Generate a comprehensive HTML report with all comparisons",
        inputSchema: {
          reportData: z.string().describe("JSON string of comparison results"),
          outputPath: z.string().optional().describe("Output path for the report"),
        },
      },
      async ({ reportData, outputPath }) => {
        try {
          const results: ComparisonResult[] = JSON.parse(reportData);
          const htmlReport = this.generateHTMLReport(results);
          
          const reportPath = outputPath || path.join(__dirname, 'dist', 'design-verification-report.html');
          await fs.mkdir(path.dirname(reportPath), { recursive: true });
          await fs.writeFile(reportPath, htmlReport);
          
          return {
            content: [{
              type: "text",
              text: `Detailed HTML report generated: ${reportPath}`
            }]
          };
        } catch (error) {
          throw new Error(`Report generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }
    );
  }

  private extractNodesWithDimensions(node: FigmaNode): FigmaNode[] {
    const nodes: FigmaNode[] = [];
    
    if (node.absoluteBoundingBox) {
      nodes.push(node);
    }
    
    if (node.children) {
      for (const child of node.children) {
        nodes.push(...this.extractNodesWithDimensions(child));
      }
    }
    
    return nodes;
  }

  private async takeAnnotatedScreenshot(page: Page, viewport: ViewportSize): Promise<string> {
    // Add overlay annotations
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'design-verification-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 9999;
      `;
      document.body.appendChild(overlay);

      // Add dimension annotations to all elements
      const elements = document.querySelectorAll('*');
      elements.forEach((element, index) => {
        if (element.id === 'design-verification-overlay') return;
        
        const rect = element.getBoundingClientRect();
        if (rect.width > 20 && rect.height > 20) {
          const annotation = document.createElement('div');
          annotation.style.cssText = `
            position: absolute;
            top: ${rect.top}px;
            left: ${rect.left}px;
            width: ${rect.width}px;
            height: ${rect.height}px;
            border: 1px solid rgba(255, 0, 0, 0.5);
            background: rgba(255, 0, 0, 0.1);
            font-size: 10px;
            color: red;
            font-weight: bold;
            white-space: nowrap;
            overflow: visible;
          `;
          
          annotation.innerHTML = `
            <div style="background: rgba(255, 255, 255, 0.9); padding: 2px; margin: -15px 0 0 0;">
              ${Math.round(rect.width)}×${Math.round(rect.height)}
            </div>
          `;
          
          overlay.appendChild(annotation);
        }
      });
    });

    // Take screenshot
    const screenshotPath = path.join(__dirname, 'dist', 'screenshots', `${viewport.name}-${Date.now()}.png`);
    await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath as any, fullPage: true });

    // Remove overlay
    await page.evaluate(() => {
      const overlay = document.getElementById('design-verification-overlay');
      if (overlay) overlay.remove();
    });

    return screenshotPath;
  }

  private async getElementsInfo(page: Page, selectors?: string[]): Promise<ElementInfo[]> {
    return await page.evaluate((selectors) => {
      const elements: ElementInfo[] = [];
      const defaultSelectors = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'div', 'span', 'button', 'input', 'img'];
      const targetSelectors = selectors || defaultSelectors;
      
      targetSelectors.forEach((selector) => {
        const nodeList = document.querySelectorAll(selector);
        nodeList.forEach((element, index) => {
          const rect = element.getBoundingClientRect();
          const computed = window.getComputedStyle(element);
          
          if (rect.width > 0 && rect.height > 0) {
            elements.push({
              selector: `${selector}:nth-child(${index + 1})`,
              name: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + (element.className ? `.${element.className.split(' ').join('.')}` : ''),
              dimensions: {
                width: rect.width,
                height: rect.height,
                x: rect.left,
                y: rect.top,
              },
              computed: {
                marginTop: computed.marginTop,
                marginRight: computed.marginRight,
                marginBottom: computed.marginBottom,
                marginLeft: computed.marginLeft,
                paddingTop: computed.paddingTop,
                paddingRight: computed.paddingRight,
                paddingBottom: computed.paddingBottom,
                paddingLeft: computed.paddingLeft,
                borderWidth: computed.borderWidth,
                fontSize: computed.fontSize,
                fontFamily: computed.fontFamily,
                color: computed.color,
                backgroundColor: computed.backgroundColor,
                display: computed.display,
                position: computed.position,
                zIndex: computed.zIndex,
              },
            });
          }
        });
      });
      
      return elements;
    }, selectors);
  }

  private findMatchingFigmaNode(figmaNodes: FigmaNode[], element: ElementInfo): FigmaNode | null {
    // Simple matching logic - can be enhanced based on naming conventions
    return figmaNodes.find(node => {
      const nameSimilarity = this.calculateNameSimilarity(node.name, element.name);
      const sizeSimilarity = this.calculateSizeSimilarity(node, element);
      
      return nameSimilarity > 0.5 || sizeSimilarity > 0.8;
    }) || null;
  }

  private calculateNameSimilarity(figmaName: string, elementName: string): number {
    const figmaWords = figmaName.toLowerCase().split(/\s+/);
    const elementWords = elementName.toLowerCase().split(/[#\.\s]+/);
    
    let matches = 0;
    for (const figmaWord of figmaWords) {
      for (const elementWord of elementWords) {
        if (figmaWord.includes(elementWord) || elementWord.includes(figmaWord)) {
          matches++;
          break;
        }
      }
    }
    
    return matches / Math.max(figmaWords.length, elementWords.length);
  }

  private calculateSizeSimilarity(figmaNode: FigmaNode, element: ElementInfo): number {
    if (!figmaNode.absoluteBoundingBox) return 0;
    
    const widthDiff = Math.abs(figmaNode.absoluteBoundingBox.width - element.dimensions.width);
    const heightDiff = Math.abs(figmaNode.absoluteBoundingBox.height - element.dimensions.height);
    
    const widthSimilarity = 1 - (widthDiff / Math.max(figmaNode.absoluteBoundingBox.width, element.dimensions.width));
    const heightSimilarity = 1 - (heightDiff / Math.max(figmaNode.absoluteBoundingBox.height, element.dimensions.height));
    
    return (widthSimilarity + heightSimilarity) / 2;
  }

  private compareElementWithFigmaNode(element: ElementInfo, figmaNode: FigmaNode, viewport: ViewportSize, screenshot: string): ComparisonResult {
    const differences: ComparisonResult['differences'] = [];
    
    if (figmaNode.absoluteBoundingBox) {
      const widthDiff = Math.abs(figmaNode.absoluteBoundingBox.width - element.dimensions.width);
      const heightDiff = Math.abs(figmaNode.absoluteBoundingBox.height - element.dimensions.height);
      
      if (widthDiff > 2) {
        differences.push({
          property: 'width',
          figmaValue: figmaNode.absoluteBoundingBox.width,
          actualValue: element.dimensions.width,
          difference: widthDiff,
        });
      }
      
      if (heightDiff > 2) {
        differences.push({
          property: 'height',
          figmaValue: figmaNode.absoluteBoundingBox.height,
          actualValue: element.dimensions.height,
          difference: heightDiff,
        });
      }
    }
    
    return {
      figmaNode,
      actualElement: element,
      differences,
      viewport,
      screenshot,
    };
  }

  private async generateReport(results: ComparisonResult[]): Promise<{ reportPath: string; summary: string }> {
    const reportData = {
      generatedAt: new Date().toISOString(),
      results,
      summary: {
        totalComparisons: results.length,
        totalDifferences: results.reduce((sum, r) => sum + r.differences.length, 0),
        viewportsCovered: [...new Set(results.map(r => r.viewport.name))],
        criticalIssues: results.filter(r => r.differences.some(d => typeof d.difference === 'number' && d.difference > 10)).length,
      },
    };

    const reportPath = path.join(__dirname, 'dist', 'design-verification-report.json');
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(reportData, null, 2));

    const summary = `
Total comparisons: ${reportData.summary.totalComparisons}
Total differences found: ${reportData.summary.totalDifferences}
Viewports tested: ${reportData.summary.viewportsCovered.join(', ')}
Critical issues: ${reportData.summary.criticalIssues}
`;

    return { reportPath, summary };
  }

  private generateHTMLReport(results: ComparisonResult[]): string {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Design Verification Report</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .header { background: #f5f5f5; padding: 20px; border-radius: 5px; }
        .comparison { border: 1px solid #ddd; margin: 20px 0; padding: 20px; border-radius: 5px; }
        .viewport { background: #e3f2fd; padding: 10px; margin: 10px 0; border-radius: 3px; }
        .differences { background: #ffebee; padding: 10px; margin: 10px 0; border-radius: 3px; }
        .screenshot { max-width: 100%; margin: 10px 0; }
        .difference-item { margin: 5px 0; padding: 5px; background: white; border-left: 3px solid #f44336; }
        .no-differences { color: #4caf50; font-weight: bold; }
        table { width: 100%; border-collapse: collapse; margin: 10px 0; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; }
    </style>
</head>
<body>
    <div class="header">
        <h1>Design Verification Report</h1>
        <p>Generated on: ${new Date().toLocaleString()}</p>
        <p>Total comparisons: ${results.length}</p>
    </div>

    ${results.map((result, index) => `
        <div class="comparison">
            <h2>Comparison ${index + 1}</h2>
            
            <div class="viewport">
                <strong>Viewport:</strong> ${result.viewport.name} (${result.viewport.width}×${result.viewport.height})
            </div>
            
            <h3>Figma Node</h3>
            <table>
                <tr><th>Property</th><th>Value</th></tr>
                <tr><td>Name</td><td>${result.figmaNode.name}</td></tr>
                <tr><td>Type</td><td>${result.figmaNode.type}</td></tr>
                <tr><td>Width</td><td>${result.figmaNode.absoluteBoundingBox?.width || 'N/A'}px</td></tr>
                <tr><td>Height</td><td>${result.figmaNode.absoluteBoundingBox?.height || 'N/A'}px</td></tr>
            </table>
            
            <h3>Actual Element</h3>
            <table>
                <tr><th>Property</th><th>Value</th></tr>
                <tr><td>Name</td><td>${result.actualElement.name}</td></tr>
                <tr><td>Selector</td><td>${result.actualElement.selector}</td></tr>
                <tr><td>Width</td><td>${result.actualElement.dimensions.width}px</td></tr>
                <tr><td>Height</td><td>${result.actualElement.dimensions.height}px</td></tr>
            </table>
            
            <h3>Differences</h3>
            <div class="differences">
                ${result.differences.length > 0 ? 
                    result.differences.map(diff => `
                        <div class="difference-item">
                            <strong>${diff.property}:</strong> 
                            Figma: ${diff.figmaValue}, 
                            Actual: ${diff.actualValue}, 
                            Difference: ${diff.difference}${typeof diff.difference === 'number' ? 'px' : ''}
                        </div>
                    `).join('') : 
                    '<div class="no-differences">No significant differences found!</div>'
                }
            </div>
            
            <h3>Screenshot</h3>
            <img src="${result.screenshot}" alt="Screenshot" class="screenshot">
        </div>
    `).join('')}
</body>
</html>
    `;

    return html;
  }

  async connect(transport: StdioServerTransport) {
    await this.server.connect(transport);
  }
}

// Initialize and start the server
async function main() {
  const server = new FigmaDesignVerificationServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("Figma Design Verification MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});