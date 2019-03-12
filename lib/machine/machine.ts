/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
    AnyPush,
    attachFacts,
    DoNotSetAnyGoalsAndLock,
    ImmaterialGoals,
    not,
    onAnyPush,
    PushTest,
    SoftwareDeliveryMachine,
    StatefulPushListenerInvocation,
    whenPushSatisfies,
} from "@atomist/sdm";
import {
    createSoftwareDeliveryMachine,
    gitHubGoalStatus,
    goalState,
    SoftwareDeliveryMachineMaker,
} from "@atomist/sdm-core";
import {
    analysis,
    assessInspection,
    buildGoals,
    checkGoals,
    containerGoals,
    controlGoals,
    deployGoals,
    Interpretation,
    materialChange,
    ProjectAnalyzer,
    releaseGoals,
    testGoals,
} from "@atomist/sdm-pack-analysis";
import {
    issueSupport,
    singleIssuePerCategoryManaging,
} from "@atomist/sdm-pack-issue";
import { k8sSupport } from "@atomist/sdm-pack-k8s";
import {
    CacheScope,
    npmInstallProjectListener,
} from "@atomist/sdm-pack-node";
import { esLintReviewCategory } from "@atomist/sdm-pack-node/lib/inspection/eslint";
import { SelectedRepo } from "../common/SelectedRepoFinder";
import {
    deleteRepo,
    selectRepoToDelete,
} from "../convenience/deleteRepo";
import { publishGitHubTopicsForElements } from "../element/common/publishGitHubTopicsForElements";
import {
    addSeed,
    importSeed,
    listSeeds,
    preferencesSeedSource,
    removeSeed,
} from "../generate/seed-management/seedManagement";
import { selectSeed } from "../generate/seed-management/selectSeed";
import {
    dropDownSeedUrlParameterDefinition,
    FreeTextSeedUrlParameterDefinition,
} from "../generate/universal/seedParameter";
import { universalGenerator } from "../generate/universal/universalGenerator";
import { universalNodeGenerator } from "../generate/universal/universalNodeGenerator";
import { configureDeploymentCommand } from "../preference/deployment";
import {
    disableCommand,
    disableGoalCommand,
    disableOrgCommand,
    enableCommand,
    enableGoalCommand,
    enableOrgCommand,
} from "../preference/enablement";
import { IsSdmEnabled } from "../preference/pushTests";
import { defaultAnalyzerFactory } from "./defaultAnalyzerFactory";
import { DefaultNodeSeeds } from "./nodeSeeds";
import { DefaultSpringSeeds } from "./springSeeds";

/**
 * Type for creating analyzers. Provide an AnalyzerFactory to customize
 * the capabilities of this SDM. See the ProjectAnalyzerBuilder helper.
 */
export type AnalyzerFactory = (sdm: SoftwareDeliveryMachine) => ProjectAnalyzer;

/**
 * Options to an Uhura SDM
 */
export interface UhuraOptions {

    readonly name: string;

    /**
     * Creates the ProjectAnalyzer for this SDM. This will determine
     * how project analysis and interpretation behaves, driving project delivery.
     * Support for additional stacks will be added primarily through
     */
    readonly analyzerFactory: AnalyzerFactory;

    /**
     * The global seed repos for this SDM. They will be available to all users,
     * in additional to any seed repos associated with the current team.
     */
    globalSeeds: SelectedRepo[];

    /**
     * Optional push test to limited the types of pushes that should
     * receive our extended goals including build, test, docker build and deploy
     * Defaults to AnyPush meaning running Uhura locally would build, test and deploy
     * each push.
     */
    extendedGoals?: PushTest;
}

const defaultUhuraOptions: UhuraOptions = {
    name: "Atomist Uhura",
    analyzerFactory: defaultAnalyzerFactory,
    globalSeeds: DefaultNodeSeeds,
    extendedGoals: AnyPush,
};

/**
 * Return a function to create a new SoftwareDeliveryMachine based on the
 * given options.
 * @param {Partial<UhuraOptions>} opts
 * @return {SoftwareDeliveryMachineMaker}
 */
export function machineMaker(opts: Partial<UhuraOptions> = {}): SoftwareDeliveryMachineMaker {
    const optsToUse: UhuraOptions = {
        ...defaultUhuraOptions,
        ...opts,
    };

    return configuration => {
        const sdm = createSoftwareDeliveryMachine({
            name: optsToUse.name,
            configuration,
        });

        const analyzer = optsToUse.analyzerFactory(sdm);

        analyzer.autofixGoal.withProjectListener(npmInstallProjectListener({ scope: CacheScope.Repository }));
        analyzer.codeInspectionGoal
            .withListener(singleIssuePerCategoryManaging(esLintReviewCategory, true, () => true))
            .withProjectListener(npmInstallProjectListener({ scope: CacheScope.Repository }));

        interface Interpreted {
            interpretation: Interpretation;
        }

        // Respond to pushes to set up standard Uhura delivery stages, based on Interpretation
        sdm.withPushRules(
            whenPushSatisfies(not(IsSdmEnabled)).setGoals(DoNotSetAnyGoalsAndLock),

            // Compute the Interpretation and attach it to the current push invocation
            attachFacts<Interpreted>(async pu => {
                const interpretation = await analyzer.interpret(pu.project, pu);
                return { interpretation };
            }),

            // If the change isn't important, don't do anything
            whenPushSatisfies<StatefulPushListenerInvocation<Interpreted>>(materialChange)
                .itMeans("immaterial change")
                .setGoals(ImmaterialGoals.andLock()),

            // Set specific goals depending on the Interpretation
            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("control")
                .setGoalsWhen(pu => controlGoals(pu.facts.interpretation)),
            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("checks")
                .setGoalsWhen(pu => checkGoals(pu.facts.interpretation, analyzer)),
            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("build")
                .setGoalsWhen(pu => buildGoals(pu.facts.interpretation, analyzer)),
            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("test")
                .setGoalsWhen(pu => testGoals(pu.facts.interpretation, analyzer)),
            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("container build")
                .setGoalsWhen(pu => containerGoals(pu.facts.interpretation, analyzer)),
            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("release")
                .setGoalsWhen(pu => releaseGoals(pu.facts.interpretation, analyzer)),

            // Don't schedule any further extended goals
            whenPushSatisfies(not(optsToUse.extendedGoals)).setGoals(DoNotSetAnyGoalsAndLock),

            onAnyPush<StatefulPushListenerInvocation<Interpreted>>()
                .itMeans("deploy")
                .setGoalsWhen(pu => deployGoals(pu.facts.interpretation, analyzer)),
        );

        sdm.addCommand(selectRepoToDelete);
        sdm.addCommand(deleteRepo);

        sdm.addCodeInspectionCommand(assessInspection(analyzer));

        sdm.addGeneratorCommand(importSeed(analyzer));
        sdm.addCommand(addSeed(analyzer));
        sdm.addCommand(removeSeed());
        sdm.addCommand(listSeeds(analyzer));

        // Universal generator, which requires dynamic parameters
        // Support Spring as well as Node out of the box
        sdm.addGeneratorCommand(universalGenerator(analyzer, {
            name: "UniversalGenerator",
            intent: `Create ${sdm.configuration.name.replace("@", "")}`,
            description: "create a project from any seed repo, based on analysis",
            seedParameter: FreeTextSeedUrlParameterDefinition,
        }));

        // Create any type of project from a list of seeds
        sdm.addGeneratorCommand(universalGenerator(analyzer, {
            name: "CreateAnyFromList",
            description: "Create a project from a curated list of seed repos",
            intent: `discover all ${sdm.configuration.name.replace("@", "")}`,
            seedParameter: dropDownSeedUrlParameterDefinition(
                ...optsToUse.globalSeeds, ...DefaultSpringSeeds),
        }));

        // Create Node from a free text input
        sdm.addGeneratorCommand(universalNodeGenerator({
            name: "CreateNode",
            intent: `Create node ${sdm.configuration.name.replace("@", "")}`,
            description: "create a project from any Node seed repo",
            seedParameter: FreeTextSeedUrlParameterDefinition,
        }));

        // Create Node from a list of seeds
        sdm.addGeneratorCommand(universalNodeGenerator({
            name: "CreateNodeFromList",
            description: "Create a project from a curated list of Node seed repos",
            intent: `discover node ${sdm.configuration.name.replace("@", "")}`,
            seedParameter: dropDownSeedUrlParameterDefinition(...optsToUse.globalSeeds),
        }, optsToUse.globalSeeds));

        sdm.addCommand(selectSeed({
            name: "SelectSeed",
            intent: `select seed`,
            description: "Create a new project, selecting a seed project",
            generatorName: "CreateNode",
            generatorsToShow: 5,
            sources: [preferencesSeedSource, {
                description: "Global Seeds",
                seedFinder: async () => optsToUse.globalSeeds,
            }],
        }));

        // Uhura activation control registrations
        sdm.addCommand(enableCommand(sdm))
            .addCommand(disableCommand(sdm))
            .addCommand(enableOrgCommand(sdm))
            .addCommand(disableOrgCommand(sdm))
            .addCommand(enableGoalCommand(sdm))
            .addCommand(disableGoalCommand(sdm));

        // Uhura app deployment into customer provided clusters
        sdm.addCommand(configureDeploymentCommand(sdm));

        // Whenever we see a new repo, add GitHub topics for all technology elements we've found.
        // For example, add "node", "spring" and "docker" topics
        sdm.addFirstPushListener(publishGitHubTopicsForElements(analyzer, sdm));

        // Extension Pack registrations
        sdm.addExtensionPacks(
            analysis(),
            gitHubGoalStatus(),
            goalState(),
            k8sSupport(),
            issueSupport({
                labelIssuesOnDeployment: true,
                closeCodeInspectionIssuesOnBranchDeletion: {
                    enabled: true,
                    source: esLintReviewCategory,
                },
            }),
            /*fingerprintSupport({
                fingerprints: NpmDependencyFingerprint,
                handlers: [
                    checkNpmCoordinatesImpactHandler(),
                    fingerprintImpactHandler(
                        {
                            transformPresentation: (ci, p) => {
                                return new editModes.PullRequest(
                                    `apply-fingerprint-${formatDate()}`,
                                    ci.parameters.title,
                                    ci.parameters.body,
                                    undefined,
                                    p.id.branch,
                                    {
                                        method: editModes.AutoMergeMethod.Merge,
                                        mode: editModes.AutoMergeMode.SuccessfulCheck,
                                    });
                            },
                            messageMaker,
                        },
                    )],
            }),*/
        );

        return sdm;
    };
}
