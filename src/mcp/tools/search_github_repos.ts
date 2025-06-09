import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import z from 'zod';
import { GitHubReposSearchParams } from '../../types';
import { TOOL_NAMES } from '../contstants';
import { TOOL_DESCRIPTIONS } from '../systemPrompts/tools';
import { searchGitHubRepos } from '../../impl/github/searchGitHubRepos';

// Security validation function
function sanitizeInput(input: string): string {
  if (typeof input !== 'string') {
    throw new Error('Input must be a string');
  }

  // Remove potentially dangerous characters
  const sanitized = input
    .replace(/[<>'"&]/g, '') // Remove HTML/XML chars
    .replace(/[;|&$`\\]/g, '') // Remove shell injection chars
    .trim();

  if (sanitized.length === 0) {
    throw new Error('Input cannot be empty after sanitization');
  }

  return sanitized;
}

// Smart query decomposition for multi-term queries
function decomposeQuery(query: string): {
  primaryTerm: string;
  suggestion: string;
  shouldDecompose: boolean;
} {
  const sanitized = sanitizeInput(query);

  // Check for multi-term patterns
  const hasMultipleTerms =
    /\s+/.test(sanitized) ||
    /\+/.test(sanitized) ||
    /AND|OR|NOT/i.test(sanitized);

  if (!hasMultipleTerms) {
    return { primaryTerm: sanitized, suggestion: '', shouldDecompose: false };
  }

  // Extract primary term (first meaningful word)
  const terms = sanitized.split(/[\s+]/).filter(term => term.length >= 2);
  const primaryTerm = terms[0] || sanitized;

  // Create suggestion for better workflow
  const suggestion =
    terms.length > 1
      ? `Multi-term query detected. Recommended workflow:
1. Start with primary term: "${primaryTerm}"
2. Use npm_search_packages for "${terms.join(' ')}" package discovery
3. Use github_search_topics for ecosystem terminology: "${terms.join('+')}"
4. Apply additional terms as filters once repositories are discovered`
      : '';

  return { primaryTerm, suggestion, shouldDecompose: true };
}

// Enhanced filter validation with production insights
function validateFilterCombinations(args: GitHubReposSearchParams): {
  isValid: boolean;
  warnings: string[];
  suggestions: string[];
} {
  const warnings: string[] = [];
  const suggestions: string[] = [];

  // Critical filter combination checks based on production testing
  const problematicCombinations = [
    {
      condition:
        args.owner === 'facebook' &&
        args.query === 'react' &&
        args.language === 'JavaScript',
      warning: 'facebook + react + JavaScript filter may return 0 results',
      suggestion:
        'Try: owner=facebook + query=react without language filter, or search React org instead',
    },
    {
      condition:
        args.language && args.stars !== undefined && args.stars > 10000,
      warning:
        'High star threshold with specific language may be too restrictive',
      suggestion:
        'Try lower star threshold (>1000) or remove language filter initially',
    },
    {
      condition:
        !args.owner &&
        (args.language || args.topic || args.stars !== undefined),
      warning:
        'Specific filters without owner scope may return too many or zero results',
      suggestion:
        'Provide owner parameter for better scoping, or use npm_search_packages first',
    },
  ];

  problematicCombinations.forEach(check => {
    if (check.condition) {
      warnings.push(check.warning);
      suggestions.push(check.suggestion);
    }
  });

  // Validate date formats
  const dateFields = ['created', 'updated'];
  dateFields.forEach(field => {
    const value = args[field as keyof GitHubReposSearchParams] as string;
    if (value && !/^[><]=?\d{4}-\d{2}-\d{2}$/.test(value)) {
      warnings.push(
        `${field} must be in format ">2020-01-01", "<2023-12-31", etc.`
      );
    }
  });

  // Validate numeric ranges
  if (args.limit && (args.limit < 1 || args.limit > 100)) {
    warnings.push('Limit must be between 1 and 100');
  }

  if (args.stars !== undefined && args.stars < 0) {
    warnings.push('Stars filter must be non-negative');
  }

  if (args.forks !== undefined && args.forks < 0) {
    warnings.push('Forks filter must be non-negative');
  }

  // Production best practices
  if (!args.owner) {
    suggestions.push(
      'BEST PRACTICE: Use npm_search_packages → npm_get_package workflow instead of direct repository search'
    );
  }

  return {
    isValid: warnings.length === 0,
    warnings,
    suggestions,
  };
}

// Generate fallback suggestions for failed searches
function generateFallbackSuggestions(args: GitHubReposSearchParams): string[] {
  const suggestions = [
    `1. Try npm_search_packages with "${args.query}" for package-based discovery`,
    `2. Use github_search_topics with "${args.query}" for ecosystem terminology`,
    `3. Remove restrictive filters: ${args.language ? 'language, ' : ''}${args.stars ? 'stars, ' : ''}${args.topic ? 'topic' : ''}`.replace(
      /, $/,
      ''
    ),
  ];

  if (args.owner) {
    suggestions.push(`4. Try broader search without owner filter`);
  }

  if (args.language) {
    suggestions.push(`4. Remove language filter and search more broadly`);
  }

  suggestions.push(
    `5. Use single terms only: break "${args.query}" into individual searches`
  );

  return suggestions.filter(s => !s.includes('undefined'));
}

export function registerSearchGitHubReposTool(server: McpServer) {
  server.tool(
    TOOL_NAMES.GITHUB_SEARCH_REPOSITORIES,
    TOOL_DESCRIPTIONS[TOOL_NAMES.GITHUB_SEARCH_REPOSITORIES],
    {
      query: z
        .string()
        .describe(
          'Search query for repositories. PRODUCTION TIP: Single terms work best (e.g., "react", "typescript"). Multi-term queries will be auto-decomposed with suggestions.'
        ),
      owner: z
        .string()
        .describe(
          'Repository owner/organization - RECOMMENDED for scoped, reliable results'
        ),
      archived: z.boolean().optional().describe('Filter archived state'),
      created: z
        .string()
        .optional()
        .describe('Filter by created date (format: >2020-01-01, <2023-12-31)'),
      followers: z.number().optional().describe('Filter by followers count'),
      forks: z.number().optional().describe('Filter by forks count'),
      goodFirstIssues: z
        .number()
        .optional()
        .describe('Filter by good first issues count'),
      helpWantedIssues: z
        .number()
        .optional()
        .describe('Filter by help wanted issues count'),
      includeForks: z
        .enum(['false', 'true', 'only'])
        .optional()
        .describe('Include forks in results'),
      language: z
        .string()
        .optional()
        .describe(
          'Filter by programming language - WARNING: Can cause empty results with restrictive combinations'
        ),
      license: z.string().optional().describe('Filter by license type'),
      limit: z
        .number()
        .optional()
        .default(50)
        .describe('Maximum results (default: 50, max: 100)'),
      match: z
        .enum(['name', 'description', 'readme'])
        .optional()
        .describe('Search scope restriction'),
      numberTopics: z.number().optional().describe('Filter by topics count'),
      order: z
        .enum(['asc', 'desc'])
        .optional()
        .default('desc')
        .describe('Result order (default: desc for newest first)'),
      size: z.string().optional().describe('Filter by size in KB'),
      sort: z
        .enum(['forks', 'help-wanted-issues', 'stars', 'updated', 'best-match'])
        .optional()
        .default('updated')
        .describe('Sort criteria (default: updated for recent activity)'),
      stars: z
        .number()
        .optional()
        .describe(
          'Filter by stars count - TIP: Use >100 for established projects, >10 for active ones'
        ),
      topic: z.string().optional().describe('Filter by topic/tag'),
      updated: z.string().optional().describe('Filter by last update date'),
      visibility: z
        .enum(['public', 'private', 'internal'])
        .optional()
        .describe('Filter by visibility'),
    },
    {
      title: 'Search GitHub Repositories',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async (args: GitHubReposSearchParams) => {
      try {
        // Ensure query is provided
        if (!args.query) {
          throw new Error('Query is required');
        }

        // Smart query analysis and decomposition
        const queryAnalysis = decomposeQuery(args.query);

        // Enhanced filter validation
        const validation = validateFilterCombinations(args);

        // Prepare the search with potentially decomposed query
        const searchArgs = {
          ...args,
          query: sanitizeInput(queryAnalysis.primaryTerm),
        };

        // Execute the search
        const result = await searchGitHubRepos(searchArgs);

        // Check if we got empty results and provide helpful guidance
        const resultText = result.content[0].text as string;
        const parsedResults = JSON.parse(resultText);
        const resultCount = JSON.parse(parsedResults.rawOutput).length;

        let responseText = resultText;

        // Add guidance for multi-term queries
        if (queryAnalysis.shouldDecompose) {
          responseText += `\n\n⚠️ MULTI-TERM QUERY OPTIMIZATION:\n${queryAnalysis.suggestion}`;
        }

        // Add validation warnings
        if (validation.warnings.length > 0) {
          responseText += `\n\n⚠️ FILTER WARNINGS:\n${validation.warnings.map(w => `• ${w}`).join('\n')}`;
        }

        // Add suggestions for better workflow
        if (validation.suggestions.length > 0) {
          responseText += `\n\n💡 OPTIMIZATION SUGGESTIONS:\n${validation.suggestions.map(s => `• ${s}`).join('\n')}`;
        }

        // Add fallback guidance for empty results
        if (resultCount === 0) {
          const fallbacks = generateFallbackSuggestions(args);
          responseText += `\n\n🔄 FALLBACK STRATEGIES (0 results found):\n${fallbacks.map(f => `• ${f}`).join('\n')}`;
          responseText += `\n\n📊 PRODUCTION TIP: Repository search has 99% avoidance rate. NPM + Topics workflow provides better results with less API usage.`;
        }

        // Add production best practices for successful searches
        if (resultCount > 0) {
          responseText += `\n\n✅ PRODUCTION INSIGHTS:`;
          responseText += `\n• Found ${resultCount} repositories`;
          if (resultCount >= 100) {
            responseText += `\n• TOO BROAD: Add more specific filters or use npm_search_packages for focused discovery`;
          } else if (resultCount >= 31) {
            responseText += `\n• BROAD: Consider adding language, stars, or topic filters for refinement`;
          } else if (resultCount >= 11) {
            responseText += `\n• GOOD: Manageable scope for analysis`;
          } else {
            responseText += `\n• IDEAL: Perfect scope for deep analysis`;
          }

          // Add caching recommendations for popular searches
          const popularTerms = [
            'react',
            'typescript',
            'javascript',
            'python',
            'nodejs',
            'vue',
            'angular',
          ];
          if (popularTerms.includes(args.query.toLowerCase())) {
            responseText += `\n• CACHE CANDIDATE: "${args.query}" is a popular search term - consider caching results`;
          }
        }

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
          isError: false,
        };
      } catch (error) {
        const fallbacks = generateFallbackSuggestions(args);
        const errorMessage = `❌ Repository search failed: ${(error as Error).message}

🔄 RECOMMENDED FALLBACK WORKFLOW:
${fallbacks.map(f => `• ${f}`).join('\n')}

💡 PRODUCTION NOTE: This tool is a last resort. For reliable discovery:
1. Start with npm_search_packages for package-based discovery
2. Use github_search_topics for ecosystem terminology  
3. Use npm_get_package to extract repository URLs
4. Only use repository search when NPM + Topics completely fail`;

        return {
          content: [
            {
              type: 'text',
              text: errorMessage,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
