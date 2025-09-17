const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const { Octokit } = require('@octokit/rest');
const archiver = require('archiver');
const fs = require('fs').promises;
const path = require('path');

class GitHubAnalyzer {
  constructor(token) {
    this.octokit = new Octokit({
      auth: token || undefined,
    });
  }

  async analyzeRepository(repoUrl) {
    const { owner, repo } = this.parseRepoUrl(repoUrl);
    
    try {
      // Get repository metadata
      const { data: repoData } = await this.octokit.rest.repos.get({
        owner,
        repo,
      });

      // Get repository contents
      const { data: contents } = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: '',
      });

      // Get package.json if exists
      let packageJson = null;
      try {
        const { data: pkgData } = await this.octokit.rest.repos.getContent({
          owner,
          repo,
          path: 'package.json',
        });
        packageJson = JSON.parse(Buffer.from(pkgData.content, 'base64').toString());
      } catch (e) {
        // package.json doesn't exist
      }

      // Analyze file structure
      const files = this.extractFileStructure(contents);
      
      // Detect technology stack
      const techStack = await this.detectTechStack(owner, repo, files, packageJson);
      
      // Detect services and ports
      const services = this.detectServices(files, packageJson);
      
      // Calculate setup metrics
      const metrics = this.calculateMetrics(repoData, techStack);

      return {
        owner,
        name: repo,
        description: repoData.description || `${repo} - Development Environment`,
        url: repoData.html_url,
        files,
        techStack,
        services,
        metrics: {
          stars: repoData.stargazers_count,
          forks: repoData.forks_count,
          issues: repoData.open_issues_count,
          contributors: await this.getContributorCount(owner, repo),
          size: repoData.size,
          language: repoData.language,
        },
        hasDocker: files.some(f => f.name === 'Dockerfile'),
        hasTests: files.some(f => f.name.includes('test') || f.path.includes('test')),
        hasCi: files.some(f => f.name.includes('.yml') && (f.path.includes('.github') || f.name.includes('ci'))),
        hasDocumentation: files.some(f => f.name.toLowerCase().includes('readme')),
        estimatedSetupTime: this.estimateSetupTime(techStack, services),
        complexity: this.assessComplexity(files, techStack, services),
      };
    } catch (error) {
      if (error.status === 404) {
        throw new Error('Repository not found. Please check the URL and ensure it\'s public.');
      }
      if (error.status === 403) {
        throw new Error('Rate limit exceeded. Please provide a GitHub token for higher limits.');
      }
      throw new Error(`Failed to analyze repository: ${error.message}`);
    }
  }

  parseRepoUrl(url) {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
    if (!match) {
      throw new Error('Invalid GitHub repository URL');
    }
    return {
      owner: match[1],
      repo: match[2].replace(/\.git$/, ''),
    };
  }

  extractFileStructure(contents) {
    return contents
      .filter(item => item.type === 'file')
      .map(item => ({
        name: item.name,
        path: item.path,
        size: item.size,
        type: path.extname(item.name),
      }));
  }

  async detectTechStack(owner, repo, files, packageJson) {
    const techStack = [];

    // Node.js detection
    if (packageJson) {
      techStack.push({
        name: 'Node.js',
        icon: '🟢',
        version: packageJson.engines?.node || '>=16.0.0',
        dependencies: Object.keys(packageJson.dependencies || {}),
        confidence: 95,
      });

      // React detection
      if (packageJson.dependencies?.react) {
        techStack.push({
          name: 'React',
          icon: '⚛️',
          version: packageJson.dependencies.react,
          confidence: 90,
        });
      }

      // Vue detection
      if (packageJson.dependencies?.vue) {
        techStack.push({
          name: 'Vue.js',
          icon: '🟩',
          version: packageJson.dependencies.vue,
          confidence: 90,
        });
      }

      // TypeScript detection
      if (packageJson.dependencies?.typescript || packageJson.devDependencies?.typescript) {
        techStack.push({
          name: 'TypeScript',
          icon: '🔷',
          version: packageJson.dependencies?.typescript || packageJson.devDependencies?.typescript,
          confidence: 85,
        });
      }
    }

    // Python detection
    if (files.some(f => f.name === 'requirements.txt' || f.name === 'pyproject.toml')) {
      techStack.push({
        name: 'Python',
        icon: '🐍',
        version: '3.8+',
        confidence: 90,
      });
    }

    // Go detection
    if (files.some(f => f.name === 'go.mod')) {
      techStack.push({
        name: 'Go',
        icon: '🐹',
        version: 'latest',
        confidence: 95,
      });
    }

    // Java detection
    if (files.some(f => f.name === 'pom.xml' || f.name.includes('build.gradle'))) {
      techStack.push({
        name: 'Java',
        icon: '☕',
        version: '11+',
        buildTool: files.some(f => f.name === 'pom.xml') ? 'Maven' : 'Gradle',
        confidence: 90,
      });
    }

    // Rust detection
    if (files.some(f => f.name === 'Cargo.toml')) {
      techStack.push({
        name: 'Rust',
        icon: '🦀',
        version: 'latest',
        confidence: 95,
      });
    }

    // Docker detection
    if (files.some(f => f.name === 'Dockerfile')) {
      techStack.push({
        name: 'Docker',
        icon: '🐳',
        version: 'latest',
        confidence: 100,
      });
    }

    return techStack.sort((a, b) => b.confidence - a.confidence);
  }

  detectServices(files, packageJson) {
    const services = [];
    
    // Default web service
    services.push({
      name: 'Web Server',
      type: 'web',
      port: this.detectPort(packageJson) || 3000,
    });

    // Database detection
    const hasDatabase = files.some(f => 
      f.path.includes('database') || 
      f.path.includes('migrations') ||
      f.name.includes('db')
    ) || (packageJson && (
      packageJson.dependencies?.mongoose ||
      packageJson.dependencies?.pg ||
      packageJson.dependencies?.mysql2
    ));

    if (hasDatabase) {
      services.push({
        name: 'Database',
        type: 'postgres',
        port: 5432,
      });
    }

    // Redis detection
    const hasRedis = packageJson?.dependencies?.redis || 
                    files.some(f => f.path.includes('redis'));
    
    if (hasRedis) {
      services.push({
        name: 'Redis',
        type: 'redis',
        port: 6379,
      });
    }

    return services;
  }

  detectPort(packageJson) {
    if (!packageJson) return null;
    
    const scripts = packageJson.scripts || {};
    for (const script of Object.values(scripts)) {
      const portMatch = script.match(/PORT[=:](\d+)|--port[=\s](\d+)|:(\d+)/);
      if (portMatch) {
        return parseInt(portMatch[1] || portMatch[2] || portMatch[3]);
      }
    }
    
    return null;
  }

  async getContributorCount(owner, repo) {
    try {
      const { data: contributors } = await this.octokit.rest.repos.listContributors({
        owner,
        repo,
        per_page: 100,
      });
      return contributors.length;
    } catch (e) {
      return 1;
    }
  }

  estimateSetupTime(techStack, services) {
    let minutes = 1;
    
    techStack.forEach(tech => {
      switch (tech.name) {
        case 'Node.js': minutes += 1; break;
        case 'Python': minutes += 1.5; break;
        case 'Java': minutes += 3; break;
        case 'Go': minutes += 0.5; break;
        case 'Docker': minutes += 2; break;
        default: minutes += 0.5;
      }
    });
    
    minutes += services.length * 0.5;
    
    if (minutes < 2) return '1-2 minutes';
    if (minutes < 4) return '2-4 minutes';
    if (minutes < 8) return '4-8 minutes';
    return '8+ minutes';
  }

  assessComplexity(files, techStack, services) {
    let score = 0;
    
    if (files.length > 100) score += 2;
    else if (files.length > 50) score += 1;
    
    score += techStack.length * 0.5;
    score += services.length;
    
    const complexTechs = ['Java', 'C++', '.NET'];
    if (techStack.some(tech => complexTechs.includes(tech.name))) {
      score += 2;
    }
    
    if (score < 2) return 'Simple';
    if (score < 5) return 'Medium';
    return 'Complex';
  }

  calculateMetrics(repoData, techStack) {
    return {
      popularity: repoData.stargazers_count + repoData.forks_count,
      activity: repoData.open_issues_count,
      maturity: Math.floor((Date.now() - new Date(repoData.created_at)) / (1000 * 60 * 60 * 24 * 365)),
      techDiversity: techStack.length,
    };
  }
}

class LabspaceGenerator {
  async generateLabspace(repoData) {
    const files = new Map();
    
    // Generate docker-compose.yml
    files.set('docker-compose.yml', this.generateDockerCompose(repoData));
    
    // Generate Dockerfile
    files.set('Dockerfile', this.generateDockerfile(repoData));
    
    // Generate devcontainer.json
    files.set('.devcontainer/devcontainer.json', this.generateDevContainer(repoData));
    
    // Generate VS Code settings
    files.set('.vscode/settings.json', this.generateVSCodeSettings(repoData));
    files.set('.vscode/extensions.json', this.generateVSCodeExtensions(repoData));
    
    // Generate startup script
    files.set('scripts/start.sh', this.generateStartupScript(repoData));
    
    // Generate README
    files.set('LABSPACE.md', this.generateReadme(repoData));
    
    // Generate environment file
    files.set('.env.example', this.generateEnvExample(repoData));

    return files;
  }

  generateDockerCompose(repoData) {
    const mainTech = repoData.techStack[0];
    const webService = repoData.services.find(s => s.type === 'web');
    
    let compose = `version: '3.8'

services:
  app:
    build: .
    ports:
      - "${webService?.port || 3000}:${webService?.port || 3000}"
    volumes:
      - .:/workspace
      - /workspace/node_modules
    environment:
      - NODE_ENV=development
    depends_on: []
`;

    // Add database if detected
    if (repoData.services.some(s => s.type === 'postgres')) {
      compose += `
  db:
    image: postgres:13
    environment:
      - POSTGRES_DB=app_db
      - POSTGRES_USER=dev_user
      - POSTGRES_PASSWORD=dev_password
    ports:
      - "5432:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
`;
    }

    // Add Redis if detected
    if (repoData.services.some(s => s.type === 'redis')) {
      compose += `
  redis:
    image: redis:6-alpine
    ports:
      - "6379:6379"
`;
    }

    // Add volumes section if needed
    if (repoData.services.some(s => s.type === 'postgres')) {
      compose += `
volumes:
  postgres_data:
`;
    }

    return compose;
  }

  generateDockerfile(repoData) {
    const mainTech = repoData.techStack[0];
    
    switch (mainTech?.name) {
      case 'Node.js':
        return `FROM node:18-alpine

WORKDIR /workspace

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["npm", "start"]`;

      case 'Python':
        return `FROM python:3.9-slim

WORKDIR /workspace

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["python", "app.py"]`;

      case 'Go':
        return `FROM golang:1.19-alpine AS builder

WORKDIR /workspace

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o main .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/

COPY --from=builder /workspace/main .

EXPOSE 8080

CMD ["./main"]`;

      default:
        return `FROM ubuntu:20.04

WORKDIR /workspace

RUN apt-get update && apt-get install -y \\
    curl \\
    git \\
    && rm -rf /var/lib/apt/lists/*

COPY . .

EXPOSE 8000

CMD ["echo", "Configure your start command"]`;
    }
  }

  generateDevContainer(repoData) {
    const extensions = this.getVSCodeExtensionsList(repoData.techStack);
    
    return JSON.stringify({
      name: `${repoData.name} Development Environment`,
      dockerComposeFile: '../docker-compose.yml',
      service: 'app',
      workspaceFolder: '/workspace',
      
      customizations: {
        vscode: {
          settings: {
            'terminal.integrated.defaultProfile.linux': 'bash'
          },
          extensions
        }
      },
      
      forwardPorts: repoData.services.map(s => s.port),
      postCreateCommand: this.getPostCreateCommand(repoData.techStack),
      remoteUser: 'root'
    }, null, 2);
  }

  generateVSCodeSettings(repoData) {
    const settings = {
      'editor.tabSize': 2,
      'editor.insertSpaces': true,
      'files.autoSave': 'onDelay',
      'files.autoSaveDelay': 1000,
      'terminal.integrated.cwd': '${workspaceFolder}',
    };

    repoData.techStack.forEach(tech => {
      switch (tech.name) {
        case 'Node.js':
          Object.assign(settings, {
            'typescript.preferences.quoteStyle': 'single',
            'javascript.preferences.quoteStyle': 'single',
          });
          break;
        case 'Python':
          Object.assign(settings, {
            'python.defaultInterpreterPath': '/usr/local/bin/python',
            'python.formatting.provider': 'black',
          });
          break;
      }
    });

    return JSON.stringify(settings, null, 2);
  }

  generateVSCodeExtensions(repoData) {
    const extensions = {
      recommendations: this.getVSCodeExtensionsList(repoData.techStack)
    };
    
    return JSON.stringify(extensions, null, 2);
  }

  getVSCodeExtensionsList(techStack) {
    const extensions = ['ms-vscode.vscode-json', 'ms-azuretools.vscode-docker'];

    techStack.forEach(tech => {
      switch (tech.name) {
        case 'Node.js':
          extensions.push('ms-vscode.vscode-typescript-next', 'esbenp.prettier-vscode');
          break;
        case 'Python':
          extensions.push('ms-python.python');
          break;
        case 'Go':
          extensions.push('golang.go');
          break;
        case 'Java':
          extensions.push('redhat.java');
          break;
        case 'Rust':
          extensions.push('rust-lang.rust-analyzer');
          break;
      }
    });

    return [...new Set(extensions)];
  }

  getPostCreateCommand(techStack) {
    const commands = [];
    
    techStack.forEach(tech => {
      switch (tech.name) {
        case 'Node.js':
          commands.push('npm install');
          break;
        case 'Python':
          commands.push('pip install -r requirements.txt');
          break;
        case 'Go':
          commands.push('go mod tidy');
          break;
      }
    });
    
    return commands.join(' && ');
  }

  generateStartupScript(repoData) {
    const mainTech = repoData.techStack[0];
    
    let script = `#!/bin/bash

echo "🚀 Starting ${repoData.name} development environment..."

`;

    switch (mainTech?.name) {
      case 'Node.js':
        script += `if [ -f "package.json" ]; then
    echo "📦 Installing dependencies..."
    npm install
    
    if grep -q "dev" package.json; then
        npm run dev
    elif grep -q "start" package.json; then
        npm start
    else
        node index.js || node server.js || node app.js
    fi
fi`;
        break;
      case 'Python':
        script += `if [ -f "requirements.txt" ]; then
    pip install -r requirements.txt
fi

python app.py || python main.py || python server.py`;
        break;
      default:
        script += `echo "🤖 Custom setup required"`;
    }

    script += `

echo "✅ Setup complete!"
echo "🌐 Access at: http://localhost:${repoData.services.find(s => s.type === 'web')?.port || 3000}"`;

    return script;
  }

  generateReadme(repoData) {
    return `# ${repoData.name} - Development Environment

This labspace was automatically generated for: **${repoData.owner}/${repoData.name}**

## 🚀 Quick Start

### Option 1: Docker Compose
\`\`\`bash
docker-compose up -d
\`\`\`

### Option 2: VS Code Dev Containers
1. Open this folder in VS Code
2. Click "Reopen in Container" when prompted

## 🛠 Tech Stack

${repoData.techStack.map(tech => `- **${tech.name}** (${tech.version}) - ${tech.confidence}% confidence`).join('\n')}

## 🔧 Services

${repoData.services.map(service => `- **${service.name}**: http://localhost:${service.port}`).join('\n')}

## 📊 Repository Stats

- **Stars**: ${repoData.metrics.stars}
- **Forks**: ${repoData.metrics.forks}
- **Contributors**: ${repoData.metrics.contributors}
- **Setup Time**: ~${repoData.estimatedSetupTime}
- **Complexity**: ${repoData.complexity}

---

*Generated by Labspace Generator on ${new Date().toLocaleDateString()}*`;
  }

  generateEnvExample(repoData) {
    let envContent = `# Environment variables for ${repoData.name}
NODE_ENV=development
PORT=3000

`;

    if (repoData.services.some(s => s.type === 'postgres')) {
      envContent += `# Database
DATABASE_URL=postgresql://dev_user:dev_password@db:5432/app_db

`;
    }

    if (repoData.services.some(s => s.type === 'redis')) {
      envContent += `# Redis
REDIS_URL=redis://redis:6379

`;
    }

    return envContent;
  }
}

// Express App Setup
const app = express();

// Middleware
app.use(helmet());
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests, please try again later.',
});
app.use(limiter);

// Serve static files
app.use(express.static('dist'));

// Initialize services
const analyzer = new GitHubAnalyzer();
const generator = new LabspaceGenerator();

// API Routes
app.post('/api/analyze', async (req, res) => {
  try {
    const { githubUrl, githubToken } = req.body;
    
    if (!githubUrl) {
      return res.status(400).json({ error: 'GitHub URL is required' });
    }

    const analyzerInstance = githubToken ? new GitHubAnalyzer(githubToken) : analyzer;
    const analysis = await analyzerInstance.analyzeRepository(githubUrl);
    
    res.json(analysis);
  } catch (error) {
    console.error('Analysis error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/generate', async (req, res) => {
  try {
    const { repoData } = req.body;
    
    if (!repoData) {
      return res.status(400).json({ error: 'Repository data is required' });
    }

    const files = await generator.generateLabspace(repoData);
    const filename = `labspace-${repoData.name}-${Date.now()}.zip`;
    const outputPath = path.join('/tmp', filename);
    
    // Create ZIP file
    await createZipFromMap(files, outputPath);
    
    res.json({
      success: true,
      downloadUrl: `/api/download/${filename}`,
      files: Array.from(files.keys()),
      message: 'Labspace generated successfully!'
    });
  } catch (error) {
    console.error('Generation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join('/tmp', filename);
    
    await fs.access(filePath);
    
    res.download(filePath, (err) => {
      if (err) {
        console.error('Download error:', err);
        res.status(404).json({ error: 'File not found' });
      } else {
        // Clean up file after download
        setTimeout(() => {
          fs.unlink(filePath).catch(console.error);
        }, 5000);
      }
    });
  } catch (error) {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Serve React app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// Utility function
async function createZipFromMap(filesMap, outputPath) {
  return new Promise((resolve, reject) => {
    const output = require('fs').createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    
    archive.pipe(output);
    
    for (const [filePath, content] of filesMap) {
      archive.append(content, { name: filePath });
    }
    
    archive.finalize();
  });
}

// Error handling
app.use((error, req, res, next) => {
  console.error('Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Labspace Generator running on port ${PORT}`);
  console.log(`📱 Frontend: http://localhost:${PORT}`);
  console.log(`🔧 API: http://localhost:${PORT}/api`);
});

module.exports = { GitHubAnalyzer, LabspaceGenerator };