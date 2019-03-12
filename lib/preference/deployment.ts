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

import { QueryNoCacheOptions } from "@atomist/automation-client";
import {
    CommandHandlerRegistration,
    PreferenceScope,
    SdmContext,
    slackSuccessMessage,
    slackWarningMessage,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import {
    codeLine,
    italic,
    url,
} from "@atomist/slack-messages";
import { KubernetesClusterProvider } from "../typings/types";

export interface ClusterAndNamespace {
    cluster: string;
    ns: string;
}

export interface DeploymentMapping {
    testing: ClusterAndNamespace;
    production: ClusterAndNamespace;
}

export function configureDeploymentCommand(sdm: SoftwareDeliveryMachine): CommandHandlerRegistration<{ goal: string, cluster: string, ns: string }> {
    return {
        name: "ConfigureDeployment",
        intent: `configure deployment ${sdm.configuration.name.replace("@", "")}`,
        description: "Configure deployment to k8s clusters",
        autoSubmit: true,
        parameters: {
            goal: {
                description: "",
                required: true,
                type: { kind: "single", options: [{ value: "testing", description: "Testing" }, { value: "production", description: "Production" }] },
            },
            cluster: {
                description: "Name of the k8s cluster as registered with Atomist (typically this the registration name of k8s-sdm)",
                required: false,
                type: "string",
            },
            ns: {
                description: "Namespace within the k8s cluster to deploy to (typically this is testing or production)",
                required: true,
                type: "string",
            },
        },
        listener: async ci => {
            // Validate that we have a k8s cluster provider in the workspace
            const k8sClusterResult = await ci.context.graphClient.query<KubernetesClusterProvider.Query, KubernetesClusterProvider.Variables>({
                name: "KubernetesClusterProvider",
                options: QueryNoCacheOptions,
            });
            let k8sClusters: string[] = [];
            if (!k8sClusterResult.KubernetesClusterProvider || k8sClusterResult.KubernetesClusterProvider.length === 0) {
                await ci.addressChannels(
                    slackWarningMessage(
                        "Configure Deployment",
                        `No Kubernetes clusters have been registered with this workspace.

Please follow ${url("https://docs.atomist.com/pack/kubernetes/", "instructions")} to configure a Kubernetes cluster.`, ci.context));
                return;
            } else {
                k8sClusters = k8sClusterResult.KubernetesClusterProvider.map(k => k.name);
            }

            // Now ask for the actual mapping from the phase to the cluster and namespace
            const mapping = await ci.promptFor<{ cluster: string }>({
                cluster: { type: { kind: "single", options: k8sClusters.map(c => ({ value: c, description: c })) } },
            });

            await ci.preferences.put(`k8s.deployment.${ci.parameters.goal}`, { ...mapping, ns: ci.parameters.ns }, { scope: PreferenceScope.Sdm });
            await ci.addressChannels(
                slackSuccessMessage(
                    "Configure Deployment",
                    `Successfully configured ${italic(ci.parameters.goal)} deployments for ${codeLine(`${mapping.cluster}:${ci.parameters.ns}`)}`));
        },
    };
}

export async function getCustomDeploymentMapping(ctx: SdmContext): Promise<DeploymentMapping> {
    return {
        testing: await ctx.preferences.get(`k8s.deployment.testing`, { scope: PreferenceScope.Sdm, defaultValue: undefined }),
        production: await ctx.preferences.get(`k8s.deployment.production`, { scope: PreferenceScope.Sdm, defaultValue: undefined }),
    };
}
